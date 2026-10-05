import { logRetentionDays, logRetentionCutoff } from '../core/logRetention.js';
/** @statuses-vocabulary
 * Durable decisions (replaced/refused), budget reservations and maintenance
 * cycles are separate from orchestration task status vocabulary.
 */
import { randomUUID } from 'node:crypto';
import { fingerprint } from './policy.js';
export function createMaintenanceStore(db, { now = () => new Date(), retentionDays = logRetentionDays() } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS maintenance_requests (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, target TEXT NOT NULL, action TEXT NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS maintenance_reservations (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, period TEXT NOT NULL, policy TEXT NOT NULL, kind TEXT NOT NULL, cycle TEXT NOT NULL, units INTEGER NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS maintenance_cycles (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS maintenance_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS maintenance_controls (workspace TEXT PRIMARY KEY, paused INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS maintenance_requests_target ON maintenance_requests(workspace,action,target);
    CREATE INDEX IF NOT EXISTS maintenance_requests_status ON maintenance_requests(workspace,status);
    CREATE INDEX IF NOT EXISTS maintenance_reservations_budget ON maintenance_reservations(workspace,kind,status,period);
    CREATE INDEX IF NOT EXISTS maintenance_reservations_cycle ON maintenance_reservations(workspace,cycle,kind,status);
    CREATE INDEX IF NOT EXISTS maintenance_reservations_status ON maintenance_reservations(workspace,status);
    CREATE INDEX IF NOT EXISTS maintenance_cycles_workspace ON maintenance_cycles(workspace);
    CREATE INDEX IF NOT EXISTS maintenance_events_workspace ON maintenance_events(workspace,seq);
    CREATE INDEX IF NOT EXISTS maintenance_events_age ON maintenance_events(julianday(json_extract(payload, '$.at')));`);
  function pruneLogs() {
    return Number(db.prepare("DELETE FROM maintenance_events WHERE julianday(json_extract(payload,'$.at')) < julianday(?)").run(logRetentionCutoff(retentionDays,now())).changes);
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
    return {...payload,seq:Number(row.lastInsertRowid)};
  }
  function requests(workspace){return parse(db.prepare('SELECT * FROM maintenance_requests WHERE workspace=? ORDER BY rowid').all(workspace));}
  function request(workspace,id){return parse(db.prepare('SELECT * FROM maintenance_requests WHERE workspace=? AND id=?').all(workspace,id))[0];}
  function propose(workspace,candidate) {
    return transaction(()=>{
      const version=fingerprint(candidate);const previous=parse(db.prepare('SELECT * FROM maintenance_requests WHERE workspace=? AND action=? AND target=? ORDER BY rowid DESC LIMIT 1').all(workspace,candidate.action,candidate.target))[0];
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
      const used=db.prepare("SELECT COALESCE(SUM(units),0) n FROM maintenance_reservations WHERE workspace=? AND kind=? AND (status='reserved' OR status='consumed' AND period=?)").get(workspace,kind,period).n;
      const usedCycle=db.prepare("SELECT COALESCE(SUM(units),0) n FROM maintenance_reservations WHERE workspace=? AND cycle=? AND kind=? AND status IN ('reserved','consumed')").get(workspace,cycle,kind).n;
      if(used+units>limit || usedCycle+units>cycleLimit)throw new Error('maintenance_budget_exhausted');
      if(old)db.prepare('DELETE FROM maintenance_reservations WHERE id=?').run(id);
      db.prepare('INSERT INTO maintenance_reservations VALUES(?,?,?,?,?,?,?,?,?)').run(id,workspace,period,policy,kind,cycle,units,'reserved',JSON.stringify(payload));
      return {id,status:'reserved',...payload};
    });
  }
  function updateReservation(id,payload) {const row=db.prepare('SELECT payload FROM maintenance_reservations WHERE id=?').get(id);if(!row)throw new Error('unknown_reservation');db.prepare('UPDATE maintenance_reservations SET payload=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.payload),...payload}),id);}
  function settle(id,{started=true}={}) {db.prepare("UPDATE maintenance_reservations SET status=? WHERE id=? AND status='reserved'").run(started?'consumed':'released',id);}
  function reservations(workspace){return parse(db.prepare('SELECT * FROM maintenance_reservations WHERE workspace=?').all(workspace));}
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
  function cycle(data){db.prepare('INSERT INTO maintenance_cycles VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload').run(data.id,data.workspace,data.status,JSON.stringify(data));}
  function cycles(workspace){return parse(db.prepare('SELECT * FROM maintenance_cycles WHERE workspace=? ORDER BY rowid DESC LIMIT 20').all(workspace));}
  function paused(workspace){return Boolean(db.prepare('SELECT paused FROM maintenance_controls WHERE workspace=?').get(workspace)?.paused);}
  function pause(workspace,value){db.prepare('INSERT INTO maintenance_controls VALUES(?,?) ON CONFLICT(workspace) DO UPDATE SET paused=excluded.paused').run(workspace,value?1:0);}
  return {requests,request,statusPage,pruneLogs,propose,decide,reserve,settle,reservations,updateReservation,cycle,cycles,paused,pause,event,
    events:(workspace,after=0)=>{pruneLogs();return parse(db.prepare(after>0?'SELECT seq,payload FROM maintenance_events WHERE workspace=? AND seq>? ORDER BY seq LIMIT 1000':'SELECT seq,payload FROM (SELECT seq,payload FROM maintenance_events WHERE workspace=? AND seq>? ORDER BY seq DESC LIMIT 1000) ORDER BY seq').all(workspace,after));},
    clear:(workspace)=>{for(const table of ['maintenance_requests','maintenance_reservations','maintenance_cycles','maintenance_events','maintenance_controls'])db.prepare(`DELETE FROM ${table} WHERE workspace=?`).run(workspace);}};
}
