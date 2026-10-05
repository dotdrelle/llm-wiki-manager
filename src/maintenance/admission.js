// Shared admission boundary for foreground dispatch and maintenance. Job locks
// remain authoritative; this boundary orders starts without stealing a lock.
const workspaces=new Map();
const scopes=(task)=>task.locks?.length ? task.locks : ['*'];
const conflict=(a,b)=>a.includes('*')||b.includes('*')||a.some((x)=>b.includes(x))||[...a,...b].some((x)=>/workspace.*(write|all)|workspace-write/.test(x));
export function enableMaintenanceAdmission(workspace){if(!workspaces.has(workspace))workspaces.set(workspace,{holders:[],waiting:[]});}
/**
 * `label` names the holder in a waiter's announcement; `onWait` is called with
 * the blocking labels each time they change, so a wait is never silent.
 */
export async function admitExecution(workspace,task,{background=false,signal,label='',onWait}={}) {
  const state=workspaces.get(workspace);if(!state)return ()=>{};
  const request={background,scopes:scopes(task),label};state.waiting.push(request);
  let announced='';
  try {
    for(;;){
      signal?.throwIfAborted();
      const blockers=state.holders.filter((h)=>(background || h.background)&&conflict(h.scopes,request.scopes));
      const priority=background?state.waiting.filter((r)=>!r.background&&conflict(r.scopes,request.scopes)):[];
      if(!blockers.length&&!priority.length){state.holders.push(request);return ()=>{state.holders=state.holders.filter((h)=>h!==request);};}
      const names=[...blockers.map((h)=>h.label||(h.background?'a maintenance action':'a task')),...priority.map((r)=>r.label||'a user task')].join(', ');
      if(names!==announced){announced=names;try{onWait?.(names);}catch{/* an announcement never blocks admission */}}
      await new Promise((resolve)=>setTimeout(resolve,100));
    }
  }finally{state.waiting=state.waiting.filter((r)=>r!==request);}
}
