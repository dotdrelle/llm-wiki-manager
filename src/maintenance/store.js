import { logRetentionDays, logRetentionCutoff } from '../core/logRetention.js';
/** @statuses-vocabulary
 * Durable decisions (replaced/refused), budget reservations and maintenance
 * cycles are separate from orchestration task status vocabulary.
 */
import { randomUUID } from 'node:crypto';
import { fingerprint } from './policy.js';
export function createMaintenanceStore(db, { now = () => new Date(), retentionDays = logRetentionDays(), onChange = () => {} } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS maintenance_requests (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, target TEXT NOT NULL, action TEXT NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS maintenance_reservations (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, period TEXT NOT NULL, policy TEXT NOT NULL, kind TEXT NOT NULL, cycle TEXT NOT NULL, units INTEGER NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS maintenance_cycles (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS maintenance_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS maintenance_controls (workspace TEXT PRIMARY KEY, paused INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS maintenance_requests_target ON maintenance_requests(workspace,action,target);
    CREATE INDEX IF NOT EXISTS maintenance_requests_status ON maintenance_requests(workspace,status);
    CREATE INDEX IF NOT EXISTS maintenance_requests_version ON maintenance_requests(workspace,version,status);
    CREATE INDEX IF NOT EXISTS maintenance_reservations_identity ON maintenance_reservations(workspace,json_extract(payload,'$.identity'),kind,status);
    CREATE INDEX IF NOT EXISTS maintenance_reservations_mail ON maintenance_reservations(workspace,json_extract(payload,'$.candidate.action'),json_extract(payload,'$.candidate.target'),status,json_extract(payload,'$.outcome'),CAST(json_extract(payload,'$.candidate.args.uptoSeq') AS INTEGER) DESC);
    CREATE INDEX IF NOT EXISTS maintenance_reservations_mail_version ON maintenance_reservations(workspace,json_extract(payload,'$.candidate.target'),json_extract(payload,'$.candidate.version'),kind,status);
    CREATE INDEX IF NOT EXISTS maintenance_reservations_budget ON maintenance_reservations(workspace,kind,status,period);
    CREATE INDEX IF NOT EXISTS maintenance_reservations_cycle ON maintenance_reservations(workspace,cycle,kind,status);
    CREATE INDEX IF NOT EXISTS maintenance_reservations_status ON maintenance_reservations(workspace,status);
    CREATE INDEX IF NOT EXISTS maintenance_cycles_workspace ON maintenance_cycles(workspace);
    CREATE INDEX IF NOT EXISTS maintenance_events_workspace ON maintenance_events(workspace,seq);
    CREATE INDEX IF NOT EXISTS maintenance_events_kind ON maintenance_events(workspace,json_extract(payload,'$.kind'),seq);
    CREATE INDEX IF NOT EXISTS maintenance_events_kind_age ON maintenance_events(workspace,json_extract(payload,'$.kind'),julianday(json_extract(payload,'$.at')),seq);
    CREATE INDEX IF NOT EXISTS maintenance_events_version ON maintenance_events(workspace,json_extract(payload,'$.kind'),json_extract(payload,'$.version'),json_extract(payload,'$.target'));
    CREATE INDEX IF NOT EXISTS maintenance_events_age ON maintenance_events(julianday(json_extract(payload, '$.at')));`);
  const changed=(workspace)=>{try{onChange(workspace);}catch{/* observers never control durable writes */}};
  function pruneLogs() {
    const expired=db.prepare("SELECT DISTINCT workspace FROM maintenance_events WHERE julianday(json_extract(payload,'$.at')) < julianday(?)").all(logRetentionCutoff(retentionDays,now()));
    const count=Number(db.prepare("DELETE FROM maintenance_events WHERE julianday(json_extract(payload,'$.at')) < julianday(?)").run(logRetentionCutoff(retentionDays,now())).changes);
    for(const row of expired)changed(row.workspace);
    return count;
  }
  // Also expire dormant workspaces, at startup and while readers browse them.
  pruneLogs();
  const parse=(rows)=>rows.map(({payload,...r})=>({...r,...JSON.parse(payload)}));
  const transaction=(fn)=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}};
  function event(workspace, data) {
    const payload={...data, at:now().toISOString()};
    const row=db.prepare('INSERT INTO maintenance_events(workspace,payload) VALUES (?,?)').run(workspace,JSON.stringify(payload));
    // Bound by age, not by volume; approvals and reservations are separate.
    pruneLogs();
    changed(workspace);
    return {...payload,seq:Number(row.lastInsertRowid)};
  }
  function requests(workspace){return parse(db.prepare('SELECT * FROM maintenance_requests WHERE workspace=? ORDER BY rowid').all(workspace));}
  function request(workspace,id){return parse(db.prepare('SELECT * FROM maintenance_requests WHERE workspace=? AND id=?').all(workspace,id))[0];}
  function propose(workspace,candidate) {
    return transaction(()=>{
      const version=fingerprint(candidate);const previous=latestRequest(workspace,candidate.action,candidate.target);
      if(previous?.version===version)return previous;
      if(previous?.status==='pending'){db.prepare("UPDATE maintenance_requests SET status='replaced' WHERE id=?").run(previous.id);event(workspace,{kind:'replaced',message:`Maintenance: request updated — ${candidate.summary}`,requestId:previous.id});}
      const id=randomUUID();db.prepare('INSERT INTO maintenance_requests VALUES(?,?,?,?,?,?,?)').run(id,workspace,candidate.target,candidate.action,version,'pending',JSON.stringify({candidate,createdAt:new Date().toISOString()}));
      event(workspace,{kind:'decision',message:`Maintenance: approval requested — ${candidate.summary}`,requestId:id,version});
      return request(workspace,id);
    });
  }
  function decide(workspace,id,version,approved) {
    return transaction(()=>{
      const selected=request(workspace,id);
      if(!selected || selected.version!==version || selected.status!=='pending')throw new Error('maintenance_request_replaced_or_not_pending');
      db.prepare('UPDATE maintenance_requests SET status=? WHERE id=?').run(approved?'approved':'refused',id);
      event(workspace,{kind:'decision_recorded',message:`Maintenance: ${approved?'approved':'refused'} by you — ${selected.candidate?.summary??selected.action}`,requestId:id});return selected;
    });
  }
  function reserve({id,workspace,policy,kind,cycle,limit,cycleLimit=Infinity,units=1,period=new Date().toISOString().slice(0,10),payload={}}) {
    return transaction(()=>{
      const old=db.prepare('SELECT * FROM maintenance_reservations WHERE id=?').get(id);
      if(old && old.status!=='released'){if(old.workspace!==workspace || old.kind!==kind)throw new Error('maintenance_reservation_identity_mismatch');return {...old,...JSON.parse(old.payload)};}
      // Active reservations from an earlier day retain capacity until reconciled.
      const used=db.prepare("SELECT COALESCE((SELECT SUM(units) FROM maintenance_reservations WHERE workspace=? AND kind=? AND status='reserved'),0)+COALESCE((SELECT SUM(units) FROM maintenance_reservations WHERE workspace=? AND kind=? AND status='consumed' AND period=?),0) n").get(workspace,kind,workspace,kind,period).n;
      const usedCycle=db.prepare("SELECT COALESCE(SUM(units),0) n FROM maintenance_reservations WHERE workspace=? AND cycle=? AND kind=? AND status IN ('reserved','consumed')").get(workspace,cycle,kind).n;
      if(used+units>limit || usedCycle+units>cycleLimit)throw new Error('maintenance_budget_exhausted');
      if(old)db.prepare('DELETE FROM maintenance_reservations WHERE id=?').run(id);
      db.prepare('INSERT INTO maintenance_reservations VALUES(?,?,?,?,?,?,?,?,?)').run(id,workspace,period,policy,kind,cycle,units,'reserved',JSON.stringify(payload));
      changed(workspace);return {id,status:'reserved',...payload};
    });
  }
  function updateReservation(id,payload) {const row=db.prepare('SELECT workspace,payload FROM maintenance_reservations WHERE id=?').get(id);if(!row)throw new Error('unknown_reservation');db.prepare('UPDATE maintenance_reservations SET payload=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.payload),...payload}),id);changed(row.workspace);}
  function settle(id,{started=true}={}) {const row=db.prepare('SELECT workspace FROM maintenance_reservations WHERE id=?').get(id);const result=db.prepare("UPDATE maintenance_reservations SET status=? WHERE id=? AND status='reserved'").run(started?'consumed':'released',id);if(result.changes)changed(row.workspace);}
  function reservations(workspace){return parse(db.prepare('SELECT * FROM maintenance_reservations WHERE workspace=?').all(workspace));}
  function activeRequests(workspace){return parse(db.prepare("SELECT * FROM maintenance_requests WHERE workspace=? AND status IN ('pending','approved') ORDER BY rowid").all(workspace));}
  function latestRequest(workspace,action,target){return parse(db.prepare('SELECT * FROM maintenance_requests WHERE workspace=? AND action=? AND target=? ORDER BY rowid DESC LIMIT 1').all(workspace,action,target))[0];}
  function refusedSelection(workspace,selection){
    const query=db.prepare("SELECT 1 FROM maintenance_requests, json_each(maintenance_requests.payload,'$.candidate.args.maintenanceSelection') AS source WHERE workspace=? AND status='refused' AND action='ingest' AND json_extract(source.value,'$.path')=? AND json_extract(source.value,'$.hash')=? LIMIT 1");
    return selection.filter(item=>query.get(workspace,item.path,item.hash));
  }
  function reservation(workspace,id){return parse(db.prepare('SELECT * FROM maintenance_reservations WHERE workspace=? AND id=?').all(workspace,id))[0];}
  function reserved(workspace,{kind,cycle,identity}={}){
    const clauses=["workspace=?","status='reserved'"];const values=[workspace];
    for(const [column,value] of [['kind',kind],['cycle',cycle],["json_extract(payload,'$.identity')",identity]])if(value!==undefined){clauses.push(column+'=?');values.push(value);}
    return parse(db.prepare('SELECT * FROM maintenance_reservations WHERE '+clauses.join(' AND ')+' ORDER BY rowid').all(...values));
  }
  function attempts(workspace,base){
    const rows=db.prepare("SELECT * FROM (SELECT rowid AS attempt_order,* FROM maintenance_reservations WHERE id=? UNION ALL SELECT rowid AS attempt_order,* FROM maintenance_reservations WHERE id>=? AND id<?) WHERE workspace=? AND kind='actions' ORDER BY attempt_order").all(base,base+':retry-',base+':retry.',workspace);
    return parse(rows.map(({attempt_order,...row})=>row));
  }
  function mailCursor(workspace,to){return db.prepare("SELECT CAST(json_extract(payload,'$.candidate.args.uptoSeq') AS INTEGER) seq FROM maintenance_reservations WHERE workspace=? AND json_extract(payload,'$.candidate.action')='mail' AND json_extract(payload,'$.candidate.target')=? AND status='consumed' AND json_extract(payload,'$.outcome')='done' ORDER BY CAST(json_extract(payload,'$.candidate.args.uptoSeq') AS INTEGER) DESC LIMIT 1").get(workspace,to)?.seq??0;}
  function hasEvent(workspace,kind,{version,target}={}){const clauses=['workspace=?',"json_extract(payload,'$.kind')=?"];const values=[workspace,kind];if(version!==undefined){clauses.push("json_extract(payload,'$.version')=?");values.push(version);}if(target!==undefined){clauses.push("json_extract(payload,'$.target')=?");values.push(target);}return Boolean(db.prepare('SELECT 1 FROM maintenance_events WHERE '+clauses.join(' AND ')+' LIMIT 1').get(...values));}
  function relevantEvents(workspace,{kinds,after=0,since}={}){const clauses=['workspace=?'];const values=[workspace];if(kinds?.length){clauses.push("json_extract(payload,'$.kind') IN ("+kinds.map(()=>'?').join(',')+")");values.push(...kinds);}if(after>0){clauses.push('seq>?');values.push(after);}if(since){clauses.push("julianday(json_extract(payload,'$.at'))>=julianday(?)");values.push(since);}return parse(db.prepare('SELECT seq,payload FROM maintenance_events WHERE '+clauses.join(' AND ')+' ORDER BY seq').all(...values));}
  function wasCompleted(workspace,candidate,period){
    const outcome="(json_extract(payload,'$.outcome')='done' OR json_extract(payload,'$.outcome')='failed' AND period=?)";
    if(db.prepare("SELECT 1 FROM maintenance_reservations WHERE workspace=? AND json_extract(payload,'$.identity')=? AND kind='actions' AND status='consumed' AND "+outcome+" LIMIT 1").get(workspace,fingerprint(candidate),period))return true;
    return candidate.action==='mail'&&Boolean(db.prepare("SELECT 1 FROM maintenance_reservations WHERE workspace=? AND json_extract(payload,'$.candidate.target')=? AND json_extract(payload,'$.candidate.version')=? AND kind='actions' AND status='consumed' AND json_extract(payload,'$.candidate.action')='mail' AND "+outcome+" LIMIT 1").get(workspace,candidate.target,candidate.version,period));
  }
  function completeRequests(workspace,version,status){const result=db.prepare("UPDATE maintenance_requests SET status=? WHERE workspace=? AND version=? AND status='approved'").run(status,workspace,version);if(result.changes)changed(workspace);}
  // Keep every actionable decision/effect visible; paginate settled history only.
  function statusPage(workspace,{historyOffset=0,historyLimit=100}={}) {
    const offset=Number.isSafeInteger(historyOffset)&&historyOffset>=0?historyOffset:0;
    const limit=Number.isSafeInteger(historyLimit)?Math.max(1,Math.min(200,historyLimit)):100;
    const page=(table,active)=>{
      const slots=active.map(()=>'?').join(',');
      const live=parse(db.prepare(`SELECT * FROM ${table} WHERE workspace=? AND status IN (${slots}) ORDER BY rowid`).all(workspace,...active));
      const total=db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE workspace=? AND status NOT IN (${slots})`).get(workspace,...active).n;
      const history=parse(db.prepare(`SELECT * FROM ${table} WHERE workspace=? AND status NOT IN (${slots}) ORDER BY rowid DESC LIMIT ? OFFSET ?`).all(workspace,...active,limit,offset));
      return {rows:[...live,...history],total};
    };
    pruneLogs();
    const eventsTotal=db.prepare('SELECT COUNT(*) n FROM maintenance_events WHERE workspace=?').get(workspace).n;
    const events=parse(db.prepare('SELECT seq,payload FROM (SELECT seq,payload FROM maintenance_events WHERE workspace=? ORDER BY seq DESC LIMIT ? OFFSET ?) ORDER BY seq').all(workspace,limit,offset));
    const requests=page('maintenance_requests',['pending','approved']);
    const reservations=page('maintenance_reservations',['reserved']);
    return {requests:requests.rows,reservations:reservations.rows,events,history:{offset,limit,hasMore:offset+limit<Math.max(requests.total,reservations.total,eventsTotal),requestsTotal:requests.total,reservationsTotal:reservations.total,eventsTotal,retentionDays}};
  }
  function cycle(data){db.prepare('INSERT INTO maintenance_cycles VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload').run(data.id,data.workspace,data.status,JSON.stringify(data));changed(data.workspace);}
  function cycles(workspace){return parse(db.prepare('SELECT * FROM maintenance_cycles WHERE workspace=? ORDER BY rowid DESC LIMIT 20').all(workspace));}
  function paused(workspace){return Boolean(db.prepare('SELECT paused FROM maintenance_controls WHERE workspace=?').get(workspace)?.paused);}
  function pause(workspace,value){db.prepare('INSERT INTO maintenance_controls VALUES(?,?) ON CONFLICT(workspace) DO UPDATE SET paused=excluded.paused').run(workspace,value?1:0);changed(workspace);}
  return {activeRequests,latestRequest,refusedSelection,reservation,reserved,attempts,mailCursor,wasCompleted,completeRequests,hasEvent,relevantEvents,requests,request,statusPage,pruneLogs,propose,decide,reserve,settle,reservations,updateReservation,cycle,cycles,paused,pause,event,
    events:(workspace,after=0)=>{pruneLogs();return parse(db.prepare(after>0?'SELECT seq,payload FROM maintenance_events WHERE workspace=? AND seq>? ORDER BY seq LIMIT 1000':'SELECT seq,payload FROM (SELECT seq,payload FROM maintenance_events WHERE workspace=? AND seq>? ORDER BY seq DESC LIMIT 1000) ORDER BY seq').all(workspace,after));},
    clear:(workspace)=>{for(const table of ['maintenance_requests','maintenance_reservations','maintenance_cycles','maintenance_events','maintenance_controls'])db.prepare(`DELETE FROM ${table} WHERE workspace=?`).run(workspace);changed(workspace);}};
}
