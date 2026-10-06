// Shared admission boundary for foreground dispatch and maintenance. Job locks
// remain authoritative; this boundary orders starts without stealing a lock.
const workspaces=new Map();
const scopes=(task)=>task.locks?.length ? task.locks : ['*'];
const conflict=(a,b)=>a.includes('*')||b.includes('*')||a.some((x)=>b.includes(x))||[...a,...b].some((x)=>/workspace.*(write|all)|workspace-write/.test(x));
export function enableMaintenanceAdmission(workspace){if(!workspaces.has(workspace))workspaces.set(workspace,{holders:[],waiting:[]});}
/**
 * `label` names the holder in a waiter's announcement; `onWait` is called with
 * the blocking labels each time they change, so a wait is never silent, and
 * `{preempting}` says whether every blocker was asked to yield.
 *
 * The user has priority: a background holder that registered `onPreempt` (a
 * maintenance action that can be stopped and replayed safely) is asked ONCE to
 * yield when a foreground request waits on it. One that cannot (an export, a
 * mail) is simply waited for. The job locks stay authoritative either way.
 */
export async function admitExecution(workspace,task,{background=false,signal,label='',onWait,onPreempt}={}) {
  const state=workspaces.get(workspace);if(!state)return ()=>{};
  const request={background,scopes:scopes(task),label,onPreempt,preemptAsked:false};state.waiting.push(request);
  let announced='';
  try {
    for(;;){
      signal?.throwIfAborted();
      const blockers=state.holders.filter((h)=>(background || h.background)&&conflict(h.scopes,request.scopes));
      const priority=background?state.waiting.filter((r)=>!r.background&&conflict(r.scopes,request.scopes)):[];
      if(!blockers.length&&!priority.length){state.holders.push(request);return ()=>{state.holders=state.holders.filter((h)=>h!==request);};}
      if(!background)for(const holder of blockers){if(holder.onPreempt&&!holder.preemptAsked){holder.preemptAsked=true;try{Promise.resolve(holder.onPreempt(label||'request')).catch(()=>{});}catch{/* a refused yield is waited for like any holder */}}}
      const preempting=!background&&blockers.length>0&&blockers.every((h)=>h.preemptAsked);
      const names=[...blockers.map((h)=>h.label||(h.background?'a maintenance action':'a task')),...priority.map((r)=>r.label||'a user task')].join(', ');
      if(names!==announced){announced=names;try{onWait?.(names,{preempting});}catch{/* an announcement never blocks admission */}}
      await new Promise((resolve)=>setTimeout(resolve,100));
    }
  }finally{state.waiting=state.waiting.filter((r)=>r!==request);}
}
