/** @statuses-vocabulary
 * Durable decisions (replaced/refused), budget reservations and maintenance
 * cycles are separate from orchestration task status vocabulary.
 */
import { randomUUID } from 'node:crypto';
import { fingerprint } from './policy.js';
export function createMaintenanceStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS maintenance_requests (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, target TEXT NOT NULL, action TEXT NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS maintenance_reservations (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, period TEXT NOT NULL, policy TEXT NOT NULL, kind TEXT NOT NULL, cycle TEXT NOT NULL, units INTEGER NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS maintenance_cycles (id TEXT PRIMARY KEY, workspace TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS maintenance_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS maintenance_controls (workspace TEXT PRIMARY KEY, paused INTEGER NOT NULL DEFAULT 0);`);
  const parse=(rows)=>rows.map(({payload,...r})=>({...r,...JSON.parse(payload)}));
  const transaction=(fn)=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}};
  function event(workspace, data) {
    const payload={...data, at:new Date().toISOString()};
    const row=db.prepare('INSERT INTO maintenance_events(workspace,payload) VALUES (?,?)').run(workspace,JSON.stringify(payload));
    // Bounded history, without deleting approvals or reservations.
    db.prepare('DELETE FROM maintenance_events WHERE workspace=? AND seq NOT IN (SELECT seq FROM maintenance_events WHERE workspace=? ORDER BY seq DESC LIMIT 1000)').run(workspace,workspace);
    return {...payload,seq:Number(row.lastInsertRowid)};
  }
  function requests(workspace){return parse(db.prepare('SELECT * FROM maintenance_requests WHERE workspace=? ORDER BY rowid').all(workspace));}
  function propose(workspace,candidate) {
    return transaction(()=>{
      const version=fingerprint(candidate);const previous=requests(workspace).filter((r)=>r.action===candidate.action && r.target===candidate.target).at(-1);
      if(previous?.version===version)return previous;
      if(previous?.status==='pending'){db.prepare("UPDATE maintenance_requests SET status='replaced' WHERE id=?").run(previous.id);event(workspace,{kind:'replaced',message:`Maintenance: request updated — ${candidate.summary}`,requestId:previous.id});}
      const id=randomUUID();db.prepare('INSERT INTO maintenance_requests VALUES(?,?,?,?,?,?,?)').run(id,workspace,candidate.target,candidate.action,version,'pending',JSON.stringify({candidate,createdAt:new Date().toISOString()}));
      event(workspace,{kind:'decision',message:`Maintenance: approval requested — ${candidate.summary}`,requestId:id,version});
      return requests(workspace).find((r)=>r.id===id);
    });
  }
  function decide(workspace,id,version,approved) {
    return transaction(()=>{
      const request=requests(workspace).find((r)=>r.id===id);
      if(!request || request.version!==version || request.status!=='pending')throw new Error('maintenance_request_replaced_or_not_pending');
      db.prepare('UPDATE maintenance_requests SET status=? WHERE id=?').run(approved?'approved':'refused',id);
      event(workspace,{kind:'decision_recorded',message:`Maintenance: ${approved?'approved':'refused'} by you — ${request.candidate?.summary??request.action}`,requestId:id});return request;
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
  function cycle(data){db.prepare('INSERT INTO maintenance_cycles VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload').run(data.id,data.workspace,data.status,JSON.stringify(data));}
  function cycles(workspace){return parse(db.prepare('SELECT * FROM maintenance_cycles WHERE workspace=? ORDER BY rowid DESC LIMIT 20').all(workspace));}
  function paused(workspace){return Boolean(db.prepare('SELECT paused FROM maintenance_controls WHERE workspace=?').get(workspace)?.paused);}
  function pause(workspace,value){db.prepare('INSERT INTO maintenance_controls VALUES(?,?) ON CONFLICT(workspace) DO UPDATE SET paused=excluded.paused').run(workspace,value?1:0);}
  return {requests,propose,decide,reserve,settle,reservations,updateReservation,cycle,cycles,paused,pause,event,
    events:(workspace,after=0)=>parse(db.prepare('SELECT seq,payload FROM maintenance_events WHERE workspace=? AND seq>? ORDER BY seq LIMIT 1000').all(workspace,after)),
    clear:(workspace)=>{for(const table of ['maintenance_requests','maintenance_reservations','maintenance_cycles','maintenance_events','maintenance_controls'])db.prepare(`DELETE FROM ${table} WHERE workspace=?`).run(workspace);}};
}
