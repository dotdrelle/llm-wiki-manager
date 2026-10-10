import { parse as parseYaml } from 'yaml';
/** @statuses-vocabulary
 * Maintenance cycles, reservations and independent provider jobs have their
 * own lifecycle; these statuses are not Donna DAG task statuses.
 */
import { readTaxoConceptPagesAsync, detectTaxoConflicts } from '../orchestrator/knowledgeSignals.js';
import { persistWorktreeProposal } from '../orchestrator/resultAggregator.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { maintenancePolicy, actionMode, inBuildWindow, MAINTENANCE_ACTIONS, fingerprint, describeReasons, describeError, fileNames } from './policy.js';
import { createMaintenanceStore } from './store.js';
import { readMaintenanceAccessDocument, setMaintenanceEnabled, setMaintenanceMode } from '../core/mcpEndpoints.js';
import { capabilityRegistryForSession } from '../orchestrator/capabilityRegistry.js';
import { discoverRuntimeProvidersOnce } from '../orchestrator/providers/runtimeProviders.js';
import { callMcpTool, formatMcpToolResult } from '../core/mcp.js';
import { activeProfileMcp, activeProfileModel, acceptsArgument, externalRoleProgress } from '../orchestrator/dispatcher.js';
import { validateJsonSchema } from '../orchestrator/planValidator.js';
import { admitExecution, enableMaintenanceAdmission } from './admission.js';
import { listWorkspaces } from '../core/workspaces.js';

// The collective's roles in their order, each pending, running or done — what
// the served run graph draws under a maintenance action.
export function maintenanceRoles({roles,finished,current}) {
  return roles.map((name)=>({name,status:finished.has(name)?'done':name===current?'running':'pending'}));
}

// Actions the manager runs itself, never through an agent cycle.
const ROUTINE=new Set(['sync','doctor','mail']);
// Actions a user request may interrupt: stopping them leaves nothing half
// done (TAXO skips the sections already written, an export redelivers, an index
// or a build is recomputed), and a later scan replays them. An existing export
// update or a mail is never interrupted — whether it took effect is not known.
const PREEMPTIBLE=new Set(['sync','ingest','index','rebuild','build']);
// No action may hold its admission indefinitely: a Confluence export waiting
// on an unreachable host kept raw/untracked for 20+ minutes on juno while the
// user's ingest sat at 0%. Fixed ceilings, in minutes — not a setting.
const ACTION_CEILING_MINUTES={sync:30,ingest:120,index:60,rebuild:180,build:60,deliver:30,doctor:15,curate:90,mail:5};
// After a stop request, how long the agent has to confirm the job ended.
const CANCEL_CONFIRM_MS=120_000;
const modeFor=(p,c)=>{const mode=actionMode(p,c.action,c.target);return c.humanEdit&&mode==='auto'?'ask':mode;};
const terminal=(s)=>['done','completed','succeeded','failed','error','cancelled'].includes(s);
const parse=(r)=>{if(r?.content){const text=formatMcpToolResult(r);try{return JSON.parse(text);}catch{return parseYaml(text);}}return r;};
// An agent restarted without its job record answers `{ok:false, error:"Unknown
// jobId"}` (production) or `{error:{code:'unknown_job'}}` (CME) — a normal
// result, not an MCP error, and without a status. Read as "not finished", it
// kept a reservation forever and turned a Stop (hence /clear --all) into an
// endless poll. The job is gone: it ends failed, with the reason said.
const lostJob=(r)=>r?.error?.code==='unknown_job'||(r?.ok===false&&/unknown jobid/i.test(String(r.error?.message??r.error??'')));
const jobState=(r)=>lostJob(r)?{status:'failed',lost:true,error:'the agent no longer knows this job (restarted, or its record was removed)'}:r;
const wait=(signal,ms=500)=>new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(signal.reason??new Error('aborted'));};const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});});
export function createMaintenanceService({db,getContext,baseUrl,readDocument=readMaintenanceAccessDocument,callTool=callMcpTool,now=()=>new Date(),onEvent=null,onChange=null,discover=discoverRuntimeProvidersOnce,writeEnabled=setMaintenanceEnabled,writeMode=setMaintenanceMode,intervalMs=Number(process.env.WIKI_MANAGER_MAINTENANCE_INTERVAL_MS??300_000)}) {
  const store=createMaintenanceStore(db,{onChange:(workspace)=>onChange?.(workspace)});const active=new Map();const scans=new Set();const inflight=new Map();let timer;
  // The actions executing right now, with their agent's last progress: the
  // served run graph draws them, so maintenance work is seen, not only logged.
  const live=new Map();
  const setLive=(workspace,id,entry)=>{let byId=live.get(workspace);if(!entry){if(!byId?.delete(id))return;if(!byId.size)live.delete(workspace);onChange?.(workspace);return;}if(!byId)live.set(workspace,byId=new Map());if(JSON.stringify(byId.get(id))===JSON.stringify(entry))return;byId.set(id,entry);onChange?.(workspace);};
  const policy=(workspace)=>maintenancePolicy(readDocument(),workspace);
  const log=(w,kind,message,extra={})=>{let version;try{version=policy(w).version;}catch{version='invalid-policy';}const event=store.event(w,{kind,message:`Maintenance: ${message}`,origin:'maintenance',policyVersion:version,author:`maintenance:${version}`,...extra});try{onEvent?.(w,event);}catch{/* the Logs mirror never breaks the durable history */}return event;};
  // A lasting degradation is announced once, not at every scan.
  function degradedOnce(workspace,message){const text=describeError(message);const last=store.events(workspace).filter((e)=>e.kind==='degraded').at(-1);if(last?.message!==`Maintenance: ${text}`)log(workspace,'degraded',text,{detail:message});}
  async function context(workspace){const ctx=await getContext(workspace);if(!ctx?.session?.workspace)throw new Error('maintenance_workspace_unavailable');return ctx;}
  function providerFor(session,action,operation) {
    const spec=MAINTENANCE_ACTIONS[action];if(!spec)throw new Error('maintenance_unknown_action');
    const provider=capabilityRegistryForSession(session).providersFor(spec.capability).find((p)=>p.health!=='unavailable' && p.capability.supportedOperations?.includes(operation??spec.operation));
    if(!provider)throw new Error(`maintenance_capability_unavailable: ${spec.capability}`);return provider;
  }
  async function physical(ctx,p) {
    const server=Object.entries(ctx.session.mcp??{}).find(([,entry])=>(entry.tools??[]).some((t)=>t.name==='wiki_maintenance_state'))?.[0];
    if(!server)throw new Error('maintenance_state_tool_unavailable');
    return parse(await callTool(ctx.session.mcp,server,'wiki_maintenance_state',{quietMinutes:p.limits.sourceQuietMinutes}));
  }
  async function state(workspace,{forAgent=false}={}) {
    const ctx=await context(workspace);const p=policy(workspace);const facts=await physical(ctx,p);
    const candidates=[];
    const add=(action,target,version,args,summary,operation)=>candidates.push({action,target,version,args,summary,...(operation?{operation}:{})});
    const requests=store.activeRequests(workspace);
    const refusedSources=store.refusedSelection(workspace,facts.pending??[]);
    const pending=(facts.pending??[]).filter((f)=>f.stable&&!f.protected&&!refusedSources.some((r)=>r.path===f.path&&r.hash===f.hash));
    if(pending.length)add('ingest','raw/untracked',fingerprint(pending.map((f)=>[f.path,f.hash])),{inputs:pending.map((f)=>f.path),maintenanceSelection:pending.map(({path,hash})=>({path,hash})),maintenanceQuietMinutes:p.limits.sourceQuietMinutes},`Ingest ${pending.length} new source(s) from the pending area: ${fileNames(pending.map((f)=>f.path))}`);
    if(facts.index?.enabled&&!facts.index.fresh)add('index','wiki',facts.wikiHash,{},'Rebuild the vector search index, which is behind the wiki content');
    // Maintenance keeps EXISTING publications current; a first export or polish
    // is a human decision it never proposes (the user's own rule).
    const receipts=facts.publications??[];
    for(const item of facts.deliverables??[]) {
      if(!item.fresh){const edited=item.reasons.includes('output_modified');add('build',item.template,item.version,{templates:[item.template],stabilize:true},`Rebuild ${fileNames([item.output])} because ${describeReasons(item.reasons)}${edited?(item.handSectionsTracked?'. Sections you added are kept as you wrote them; sections the template produces are updated with the new content (the current file is backed up first). Approve to proceed':'. This first rebuild cannot yet tell sections you added from the template\'s: they may be removed (the current file is backed up first in .wiki/output-backups/; later rebuilds keep them). Approve to proceed'):''}`);if(edited)candidates.at(-1).humanEdit=true;}
      const exportReceipt=receipts.find((r)=>r.source===item.output&&r.operation==='export');
      const hasExport=Boolean(item.artifacts?.export||exportReceipt);
      if(item.fresh&&hasExport&&!exportReceipt?.fresh)add('deliver',item.output,fingerprint([item.version,facts.publicationTransforms?.export??exportReceipt?.expectedTransform??null]),{deliverables:[item.output]},`Update the existing export of ${fileNames([item.output])}${exportReceipt?.reason==='settings_changed'?' because the export settings changed (prompt version or language)':''}`,'export');
    }
    for(const receipt of receipts) {
      if(receipt.operation!=='export'||!receipt.fresh)continue;
      const polish=receipts.find((r)=>r.operation==='polish'&&r.source===receipt.output);
      const item=(facts.deliverables??[]).find((d)=>d.output===receipt.source);
      if((polish||item?.artifacts?.polish)&&!polish?.fresh)add('deliver',receipt.output,fingerprint([receipt.outputHash,facts.publicationTransforms?.polish??polish?.expectedTransform??null]),{deliverables:[receipt.output]},`Update the existing polished version of ${fileNames([receipt.source])}${polish?.reason==='settings_changed'?' because the export settings changed (prompt version or language)':''}`,'polish');
    }
    const conflicts=detectTaxoConflicts(await readTaxoConceptPagesAsync(ctx.session.workspacePath));
    if(conflicts.total>0||store.hasEvent(workspace,'rebuild_owned',{version:facts.wikiHash}))add('rebuild','wiki',fingerprint(conflicts),{},`Rebuild the TAXO fiches and tag pages: ${conflicts.total} inconsistency(ies) found (a tag filed in several families, or a tag page citing no fiche)`);
    if(!facts.proposals?.length)add('curate','wiki',facts.wikiHash,{},'Review the wiki for duplicates, contradictions and unsourced claims, and prepare corrections for your review');
    const day=now().toISOString().slice(0,10);
    add('doctor','workspace',day,{},'Daily check of the workspace configuration and services');
    // Sync source names come from the connector's read-only configuration, never the model.
    try {
      const server=Object.entries(ctx.session.mcp??{}).find(([,entry])=>(entry.tools??[]).some((t)=>t.name==='cme_sources_list'))?.[0];
      // ONE sync for every configured source: in human mode each source used to
      // be its own approval, so a sync of N pages asked N times. The connector
      // exports all the workspace's sources when no source_name is given.
      if(server){const raw=parse(await callTool(ctx.session.mcp,server,'cme_sources_list',{workspace}));const names=(raw.sources??(Array.isArray(raw)?raw:[])).map((source)=>source.name??source.source_name).filter(Boolean).map(String);if(names.length)add('sync','confluence',fingerprint([Math.floor(now().getTime()/7_200_000),[...names].sort()]),{},`Synchronize ${names.length} Confluence source(s): ${names.slice(0,5).join(', ')}${names.length>5?` +${names.length-5}`:''}`);}
    }catch{log(workspace,'degraded','source configuration unavailable; synchronization skipped');}
    for(const f of facts.pending??[]){if(f.protected&&!store.hasEvent(workspace,'protected_source',{version:f.hash,target:f.path}))log(workspace,'protected_source',`${f.path} is waiting for human resolution (${f.reason})`,{version:f.hash,target:f.path});}
    const reservations=store.reserved(workspace);
    // Mail is routine (no model): an alert for each new failure/decision batch,
    // and one digest per day for the previous day. Recipients come only from
    // maintenanceAccess.mail.to — the agent cannot name another one.
    if(p.mail.to.length){
      const alertKinds=['failure','decision'].filter((k)=>p.mail.on.includes(k));
      const yesterday=new Date(now().getTime()-86_400_000).toISOString().slice(0,10);
      const digestKinds=['action_done','failure','decision','protected_source','recommendation'];
      for(const to of p.mail.to){
        const cursor=store.mailCursor(workspace,to);
        // The mail action's own lines are never mail material: quoting a failed
        // send back into the next alert changed its cursor and retried it until
        // the daily budget. The digest covers yesterday only, never today.
        const alerts=alertKinds.length?store.relevantEvents(workspace,{kinds:alertKinds,after:cursor,excludeAction:'mail'}):[];
        if(alerts.length){const upto=alerts.at(-1).seq;add('mail',to,`alert:${upto}`,{to,uptoSeq:upto,subject:`Wiki maintenance — ${workspace}: ${alerts.length} item(s) need attention`,body:alerts.slice(-20).map((e)=>e.message).join('\n')},`Email ${to} about ${alerts.length} failure(s) or decision(s)`);}
        const digest=p.mail.on.includes('daily')?store.relevantEvents(workspace,{kinds:digestKinds,since:yesterday,before:day,excludeAction:'mail'}):[];
        if(digest.length)add('mail',to,`daily:${yesterday}`,{to,subject:`Wiki maintenance — ${workspace}: summary of ${yesterday}`,body:digest.slice(-50).map((e)=>e.message).join('\n')},`Email ${to} the summary of ${yesterday}`);
      }
    }
    // An action refused by its daily budget waits for tomorrow instead of looping.
    const budgetBlocked=new Set(store.relevantEvents(workspace,{kinds:['budget_exhausted'],since:day}).map((e)=>e.identity).filter(Boolean));
    // A failed action is not offered again the same day unless it changes (a new
    // identity). A certain refusal before dispatch releases the budget units, so
    // the reservation alone cannot remember it: the failure event carries the
    // identity, and this filter is what stops a hopeless sync from being retried
    // at every scan. A new content/version produces a new identity and is allowed.
    const failedToday=new Set(store.relevantEvents(workspace,{kinds:['failure'],since:day}).map((e)=>e.identity).filter(Boolean));
    const available=candidates.filter((candidate)=>!budgetBlocked.has(fingerprint(candidate))&&!failedToday.has(fingerprint(candidate))&&!store.wasCompleted(workspace,candidate,day));
    // The agent never sees routine work: the manager already runs it without a model.
    // Nor its decisions: an approved sync whose candidate had changed was
    // retried by the agent at every cycle (maintenance_target_not_current).
    return {policy:p,paused:store.paused(workspace),facts,candidates:available.filter((c)=>!forAgent||!ROUTINE.has(c.action)).map((c)=>({...c,mode:modeFor(p,c),outsideWindow:c.action==='build'&&!inBuildWindow(p,now())})),requests:forAgent?requests.filter((r)=>!ROUTINE.has(r.action)):requests,reservations,cycles:store.cycles(workspace).map(({secret,...c})=>c),events:store.events(workspace)};
  }
  function authorizeBridge(cycleId,token) {
    const cycle=db.prepare('SELECT payload FROM maintenance_cycles WHERE id=?').get(cycleId);
    if(!cycle)return null;const data=JSON.parse(cycle.payload);const a=Buffer.from(String(data.secret??''));const b=Buffer.from(String(token??''));
    return a.length&&a.length===b.length&&timingSafeEqual(a,b)&&['running','recovering'].includes(data.status)?data:null;
  }
  async function runCandidate(workspace,cycleId,input,signal) {
    if(!MAINTENANCE_ACTIONS[input.action])throw new Error('maintenance_unknown_action');
    let view=await state(workspace);const matchingTarget=view.candidates.filter((c)=>c.action===input.action&&c.target===input.target);
    let candidate=matchingTarget.find((c)=>input.operation==null?c.operation==null:c.operation===input.operation);
    if(!candidate)throw new Error(matchingTarget.length?'maintenance_operation_not_current':'maintenance_target_not_current');
    const {mode,outsideWindow,...clean}=candidate;candidate=clean;
    const p=policy(workspace);
    if(!p.enabled||store.paused(workspace))throw new Error('maintenance_disabled_or_paused');
    if(mode==='off'){log(workspace,'recommendation',`Suggested, not done (this action is turned off in maintenanceAccess): ${candidate.summary}`);return {status:'off'};}
    if(outsideWindow){log(workspace,'waiting',`${candidate.summary} — scheduled for the next build window`);return {status:'waiting'};}
    const identity=fingerprint(candidate);
    const held=store.reserved(workspace,{kind:'actions',identity})[0];
    // One identity per candidate and day; a Stop that cancelled it opens a new
    // attempt, otherwise the cancelled outcome would be replayed forever.
    const base=fingerprint([workspace,candidate,now().toISOString().slice(0,10)]);
    const attempts=store.attempts(workspace,base);
    const last=attempts.at(-1);
    // A preempted attempt is `released` (its credit returned), a stopped one
    // `consumed`: both open a new attempt, whose new idempotency key keeps the
    // agent from answering with the cancelled job.
    const id=held?.id??(['consumed','released'].includes(last?.status)&&last.outcome==='cancelled'?`${base}:retry-${attempts.length}`:base);const previous=store.latestRequest(workspace,candidate.action,candidate.target);
    let approved=previous?.version===identity&&previous.status==='approved';
    if(mode==='ask'&&!approved){const request=store.propose(workspace,candidate);return {status:request.status,request:{id:request.id,version:request.version,summary:candidate.summary}};}
    const ctx=await context(workspace);const spec=MAINTENANCE_ACTIONS[candidate.action];
    const operation=candidate.operation??spec.operation;let provider=providerFor(ctx.session,candidate.action,operation);
    // Only actions that touch the workspace take an admission, scoped to what they
    // touch; a read, a worktree curation or a mail never holds a user's task.
    const scopes=spec.scopes?.(candidate.target)??null;
    let release=()=>{};
    // A user request asked this action to yield (admission onPreempt). Before
    // the dispatch it simply never starts; after it, the job is stopped.
    const preemption={requested:false,by:'',cancel:null};
    const preempt=async(by)=>{
      if(preemption.requested)return;preemption.requested=true;preemption.by=by;
      log(workspace,'waiting',`${candidate.summary} — pausing: your ${by} goes first`);
      await preemption.cancel?.();
    };
    if(scopes){
      enableMaintenanceAdmission(workspace);
      // Existing foreground work is registered before we request a conflicting start.
      if(ctx.running&&(ctx.session.headlessPlan??[]).some((t)=>!terminal(t.status))){log(workspace,'waiting',`${candidate.summary} — waiting: your run in progress goes first`);return {status:'waiting',reason:'foreground_run_pending'};}
      // A request queued behind that run is the user's work too.
      if((ctx.session.controlQueue??[]).some((item)=>item.status==='queued')){log(workspace,'waiting',`${candidate.summary} — waiting: your queued request goes first`);return {status:'waiting',reason:'foreground_queue_pending'};}
      release=await admitExecution(workspace,{locks:scopes},{background:true,signal,label:`maintenance: ${candidate.summary}`,onWait:(holders)=>log(workspace,'waiting',`${candidate.summary} — waiting for ${holders}`),
        ...(PREEMPTIBLE.has(candidate.action)?{onPreempt:(by)=>preempt(by)}:{})});
    }
    let reserved=false,started=false,unfollowRoles=null;
    // Counted as an active run while it executes: a config or connector change
    // must not land under it, and the shell must not stop the runtime.
    inflight.set(workspace,(inflight.get(workspace)??0)+1);
    try {
      const current=policy(workspace);
      if(current.version!==p.version||!current.enabled||store.paused(workspace))throw new Error('maintenance_policy_changed');
      const revalidated=(await state(workspace)).candidates.find((c)=>c.action===candidate.action&&c.target===candidate.target&&c.operation===candidate.operation);
      if(!revalidated||revalidated.version!==candidate.version)throw new Error('maintenance_target_changed');
      // Admission can wait while discovery changes. Resolve the live contract
      // again before validating arguments and dispatching any external effect.
      provider=providerFor(ctx.session,candidate.action,operation);
      store.reserve({id,workspace,policy:p.version,kind:'actions',cycle:cycleId,limit:p.limits.actionsPerDay,cycleLimit:p.limits.actionsPerCycle,payload:{identity,candidate}});reserved=true;
      if(candidate.action==='build')store.reserve({id:id+':build',workspace,policy:p.version,kind:'builds',cycle:cycleId,limit:p.limits.buildsPerDay,payload:{identity}});
      const existing=store.reservation(workspace,id);
      if(existing?.status==='consumed')return existing.result??{status:existing.outcome};
      log(workspace,'action_started',candidate.summary,{cycleId,action:candidate.action,target:candidate.target});
      const agentArgs={...candidate.args};
      delete agentArgs.uptoSeq;
      // uptoSeq is the manager's alert cursor, never an executor argument.
      const args={...agentArgs};
      if(acceptsArgument(provider.capability.inputSchema,'callerLabel'))args.callerLabel=`maintenance:${p.version}`;
      if(acceptsArgument(provider.capability.inputSchema,'confirm'))args.confirm=true;
      if(ctx.session.wikirc?.fileName&&acceptsArgument(provider.capability.inputSchema,'configPath'))args.configPath=ctx.session.wikirc.fileName;
      const errors=validateJsonSchema(provider.capability.inputSchema,args);if(errors.length)throw new Error('maintenance_arguments_invalid');
      let job=existing?.jobId;
      if(!job){
        if(existing?.dispatched&&provider.runtimeProvider)throw new Error('maintenance_dispatch_uncertain: external receipt requires reconciliation');
        if(preemption.requested)throw new Error('maintenance_preempted');
        // Persist dispatch intent before any external effect. Idempotent agents
        // reconcile an unknown response using the identical request/key.
        store.updateReservation(id,{dispatched:true,provider:provider.serverName,runtimeId:provider.runtimeId});started=true;
        let response;
        if(provider.runtimeProvider){
          response=await provider.runtimeProvider.execute({capability:spec.capability,operation,objective:candidate.summary,workspace:{name:workspace},model:activeProfileModel(ctx.session),language:ctx.session.language,mcp:activeProfileMcp(ctx.session)});
          response={accepted:true,jobId:response.runId};
        }else response=parse(await callTool(ctx.session.mcp,provider.serverName,'agent_execute',{taskId:id,runId:cycleId,capability:spec.capability,operation,arguments:args,workspace:{name:workspace},idempotencyKey:id,constraints:{requireApprovalForMutations:true}},signal));
        if(response.accepted===false){started=false;const refusal=typeof response.error==='string'?response.error:response.error?.message;throw new Error(refusal||'maintenance_execution_refused');}
        job=response.jobId;
        if(!job)throw new Error('maintenance_execution_receipt_missing');
        store.updateReservation(id,{jobId:job});
      } else started=true;
      const liveEntry={id,action:candidate.action,target:candidate.target,operation:operation??null,summary:candidate.summary,agent:provider.runtimeId??provider.serverName??null,jobId:job,startedAt:now().toISOString(),status:'running',progress:null};
      setLive(workspace,id,liveEntry);
      // An external runtime's collective (curate, review): follow its roles, as
      // the dispatcher does for Donna's runs. Polling status() alone left the
      // run graph on one bare node for the whole curation — scout, analyst and
      // critique ran two to three minutes each with nothing drawn.
      let liveProgress=null;
      const roleState=provider.runtimeProvider?.subscribe?{declared:(provider.capability?.subagents??[]).map(String),roles:(provider.capability?.subagents??[]).map(String),finished:new Set(),current:null}:null;
      if(roleState){
        unfollowRoles=provider.runtimeProvider.subscribe(job,(event)=>{
          if(event?.type!=='subagent_started'&&event?.type!=='subagent_finished')return;
          const role=String(event.subagent??'');if(!role)return;
          if(!roleState.roles.includes(role))roleState.roles.push(role);
          if(event.type==='subagent_started')roleState.current=role;
          else{roleState.finished.add(role);if(roleState.current===role)roleState.current=null;}
          // The action keeps its own title; the role line goes to the detail.
          const {label:_roleLabel,...roleLine}=externalRoleProgress({...roleState,declared:roleState.declared.length});
          liveProgress={...liveProgress,...roleLine,roles:maintenanceRoles(roleState)};
          setLive(workspace,id,{...liveEntry,progress:liveProgress});
        });
      }
      const stopJob=async()=>{
        try{
          if(provider.runtimeProvider)await provider.runtimeProvider.cancel(job);
          else await callTool(ctx.session.mcp,provider.serverName,'agent_cancel',{jobId:job});
        }catch(error){log(workspace,'degraded',`${candidate.summary} — the stop request was not accepted: ${describeError(error.message)}`,{cycleId,action:candidate.action,target:candidate.target});}
      };
      preemption.cancel=stopJob;
      if(preemption.requested)await stopJob();
      const ceilingMs=(ACTION_CEILING_MINUTES[candidate.action]??60)*60_000;
      const clock=()=>now().getTime();const startedAt=clock();let stopAskedAt=preemption.requested?clock():0;let timedOut=false;
      // Polling backs off from 0.5 s to 5 s: a flat 500 ms over a 30-minute sync
      // is 120 calls a minute, the agents' own rate limit (MCP_RATE_LIMIT_REQUESTS)
      // — the CME then answered the registry's agent_describe with a refusal.
      let result;let polls=0;
      do{
        signal?.throwIfAborted();
        if(!stopAskedAt&&clock()-startedAt>ceilingMs){timedOut=true;stopAskedAt=clock();await stopJob();}
        if(!stopAskedAt&&preemption.requested)stopAskedAt=clock();
        result=provider.runtimeProvider?await provider.runtimeProvider.status(job):jobState(parse(await callTool(ctx.session.mcp,provider.serverName,'agent_status',{jobId:job},signal)));
        const progress=result.progress??result.result?.progress??null;
        if(progress&&typeof progress==='object'){liveProgress={...liveProgress,...progress};setLive(workspace,id,{...liveEntry,progress:liveProgress});}
        if(terminal(result.status??result.result?.status))break;
        if(stopAskedAt&&clock()-stopAskedAt>CANCEL_CONFIRM_MS)throw new Error('maintenance_cancel_unconfirmed');
        await wait(signal,Math.min(5000,Math.round(500*1.5**polls++)));
      }while(true);
      const finalStatus=result.status??result.result?.status;
      const finished=['done','completed','succeeded'].includes(finalStatus);
      // A job that finished on its own before the stop landed counts as done.
      if(!finished&&preemption.requested&&!timedOut){
        store.updateReservation(id,{outcome:'cancelled',preempted:true,result});
        store.settle(id,{started:false});if(candidate.action==='build')store.settle(id+':build',{started:false});
        log(workspace,'interrupted',`${candidate.summary} — paused so your ${preemption.by} goes first; it resumes at a later scan`,{cycleId,action:candidate.action,target:candidate.target,jobId:job});
        return {status:'preempted',result};
      }
      if(!finished&&timedOut){
        store.updateReservation(id,{outcome:'failed',timedOut:true,result});
        store.settle(id);if(candidate.action==='build')store.settle(id+':build');
        log(workspace,'failure',`${candidate.summary} — stopped after ${ACTION_CEILING_MINUTES[candidate.action]??60} min without finishing (maintenance time limit)`,{cycleId,action:candidate.action,target:candidate.target,jobId:job});
        return {status:'failed',result};
      }
      const outcome=completeJob(workspace,ctx,id,result,cycleId,view.facts.wikiHash);
      return {status:outcome,result};
    }catch(error){
      if(reserved&&!started){store.settle(id,{started:false});store.settle(id+':build',{started:false});}
      // A runtime shutdown is not a failure: the job keeps running in its agent and
      // its held reservation lets the next start resume following it.
      if(signal?.aborted&&started){
        // Three different endings, three different truths for the reader.
        const why=shutdown.signal.aborted?'still running in its agent; followed again when the runtime restarts'
          :store.paused(workspace)?'stopped by you; the job is being cancelled'
          :'the agent cycle ended first; the job keeps running and the next scan follows it';
        log(workspace,'interrupted',`${candidate.summary} — ${why}`,{cycleId,action:candidate.action,target:candidate.target});
      }
      else if(/^maintenance_preempted/.test(String(error.message)))log(workspace,'interrupted',`${candidate.summary} — not started: your ${preemption.by} goes first; it resumes at a later scan`,{cycleId,action:candidate.action,target:candidate.target});
      else if(/^maintenance_budget_exhausted:cycle/.test(String(error.message)))log(workspace,'waiting',`${candidate.summary} — cycle action budget reached; retried at the next scan`,{cycleId,action:candidate.action,target:candidate.target,detail:error.message});
      else if(/^maintenance_budget_exhausted:day/.test(String(error.message)))log(workspace,'budget_exhausted',`${candidate.summary} — waiting until tomorrow: ${describeError(error.message)}`,{cycleId,action:candidate.action,target:candidate.target,identity,detail:error.message});
      else log(workspace,'failure',`${candidate.summary} — not done: ${describeError(error.message)}`,{cycleId,action:candidate.action,target:candidate.target,identity,detail:error.message});
      throw error;
    }finally{unfollowRoles?.();setLive(workspace,id,null);release();const left=(inflight.get(workspace)??1)-1;if(left>0)inflight.set(workspace,left);else inflight.delete(workspace);}
  }
  function completeJob(workspace,ctx,id,result,cycleId,wikiHash) {
    const reservation=store.reservation(workspace,id);
    if(!reservation)throw new Error('unknown_reservation');
    if(reservation.status!=='reserved')return reservation.outcome;
    const status=result.status??result.result?.status;
    const outcome=['done','completed','succeeded'].includes(status)?'done':status==='cancelled'?'cancelled':'failed';
    const candidate=reservation.candidate;
    // The gateway stops a curation before its roles when the workspace has no
    // eligible source fiche. That is a legitimate outcome, not a completed
    // review: say what did not happen instead of reporting "Done".
    const nothingToCurate=result.result?.curationOutcome?.kind==='nothing_to_curate'
      ?(String(result.result.curationOutcome.reason??'').trim()||'no eligible wiki/sources fiches exist yet'):null;
    if(result.result?.worktreeProposal){const persisted=persistWorktreeProposal(ctx.session,result,{runId:cycleId,taskId:id});if(persisted.error)throw new Error(persisted.error);}
    if(result.result?.curationOutcome?.kind==='rebuild_owned')log(workspace,'rebuild_owned','curation findings belong to a TAXO rebuild',{version:wikiHash??candidate.version});
    store.updateReservation(id,{outcome,result});store.settle(id);
    if(candidate.action==='build')store.settle(id+':build');
    if(outcome!=='cancelled')store.completeRequests(workspace,reservation.identity,outcome);
    if(nothingToCurate)log(workspace,'nothing_to_curate',`Curation not started: ${nothingToCurate}; no curation roles ran. Ingest source documents first, then curate.`,{cycleId,action:candidate.action,target:candidate.target});
    else{
      // The gateway reports `error` as a string (CME as a string too); reading
      // only `.message` silently dropped the reason and left a bare "Failed:".
      const rawError=typeof result.error==='string'?result.error:result.error?.message??result.result?.error;
      log(workspace,outcome==='done'?'action_done':outcome==='cancelled'?'interrupted':'failure',`${outcome==='done'?'Done':outcome==='cancelled'?'Cancelled':'Failed'}: ${candidate.summary}${outcome==='failed'&&rawError?` — ${describeError(rawError)}`:''}`,{cycleId,action:candidate.action,target:candidate.target,jobId:reservation.jobId,...(outcome==='failed'&&rawError?{detail:String(rawError)}:{})});
    }
    return outcome;
  }
  // A completed job can remove its own candidate (e.g. it archived Pending).
  // Reconcile persistent receipts before detecting new work, not through that
  // candidate list. An unknown effect retains its credit and blocks new starts.
  async function reconcile(workspace,ctx) {
    let settled=true;
    for(const r of store.reserved(workspace,{kind:'actions'})) {
      if(!r.jobId){
        if(!r.dispatched){store.settle(r.id,{started:false});store.settle(r.id+':build',{started:false});continue;}
        degradedOnce(workspace,'maintenance_dispatch_uncertain: external receipt requires reconciliation');settled=false;continue;
      }
      try {
        let result;
        if(r.runtimeId){
          const provider=capabilityRegistryForSession(ctx.session).providersFor(MAINTENANCE_ACTIONS[r.candidate.action].capability).find((p)=>p.runtimeId===r.runtimeId)?.runtimeProvider;
          if(!provider)throw new Error('maintenance_gateway_unavailable');
          result=await provider.status(r.jobId);
        }else result=jobState(parse(await callTool(ctx.session.mcp,r.provider,'agent_status',{jobId:r.jobId},shutdown.signal)));
        if(result.lost)log(workspace,'failure',`${r.candidate?.summary??r.candidate?.action??'action'} — ${result.error}; its credit is settled`,{action:r.candidate?.action,jobId:r.jobId});
        if(terminal(result.status??result.result?.status))completeJob(workspace,ctx,r.id,result,r.cycle);
        else settled=false;
      }catch(error){degradedOnce(workspace,`job reconciliation interrupted: ${error.message}`);settled=false;}
    }
    return settled;
  }
  function modelAdmission(workspace,cycleId,call) {
    if(typeof call!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(call))throw new Error('maintenance_model_call_invalid');
    const p=policy(workspace);if(!p.enabled||store.paused(workspace))throw new Error('maintenance_disabled_or_paused');
    const id=`${cycleId}:model:${call}`;
    store.reserve({id,workspace,policy:p.version,kind:'modelCalls',cycle:cycleId,limit:p.limits.actionsPerDay,cycleLimit:p.limits.actionsPerCycle*3});
    return {ok:true};
  }
  const ticking=new Set();const shutdown=new AbortController();
  // close() waits for a scan in progress instead of pulling the store from under it.
  function tick(workspace){const run=scan(workspace);ticking.add(run);run.finally(()=>ticking.delete(run));return run;}
  async function scan(workspace) {
    if(scans.has(workspace)||active.has(workspace))return;scans.add(workspace);
    try {
      const p=policy(workspace);if(!p.enabled||store.paused(workspace))return;
      const ctx=await context(workspace);enableMaintenanceAdmission(workspace);
      // A context created by this very scan has not finished its first runtime
      // discovery yet: wait for it rather than report a missing gateway.
      if(ctx.session&&ctx.session.runtimeProviderAgents===undefined){try{await discover(ctx.session);}catch{/* announced below as unavailable */}}
      const host=capabilityRegistryForSession(ctx.session).providersFor('agent.maintain').find((p)=>p.runtimeProvider);
      const jobsSettled=await reconcile(workspace,ctx);
      const previous=store.cycles(workspace).find((c)=>['running','recovering'].includes(c.status));
      // An interrupted cycle is re-attached before anything new starts; without
      // the gateway it simply waits (announced below), routine work included.
      if(previous&&!host){degradedOnce(workspace,'maintenance_gateway_unavailable');return;}
      if(previous){
        if(previous.runId){active.set(workspace,{cycle:previous,provider:host.runtimeProvider});void monitor(workspace,previous,host.runtimeProvider);return;}
        const accepted=await host.runtimeProvider.execute({capability:'agent.maintain',operation:'run',workspace:{name:workspace},model:activeProfileModel(ctx.session),language:ctx.session.language,mcp:activeProfileMcp(ctx.session),maintenance:{cycleId:previous.id,endpoint:baseUrl,token:previous.secret,policy:p}});previous.runId=accepted.runId;store.cycle(previous);active.set(workspace,{cycle:previous,provider:host.runtimeProvider});void monitor(workspace,previous,host.runtimeProvider);return;
      }
      if(!jobsSettled)return;
      const clean=(c)=>Object.fromEntries(Object.entries(c).filter(([k])=>!['mode','outsideWindow'].includes(k)));
      const decided=(view,c)=>view.requests.some((r)=>['pending','refused'].includes(r.status)&&r.version===fingerprint(clean(c)));
      // Routine work needs no judgement: a scheduled sync and the daily doctor
      // run here, deterministically, without a model call or a gateway cycle.
      let view=await state(workspace);
      for(const c of view.candidates.filter((c)=>ROUTINE.has(c.action)&&c.mode!=='off'&&!decided(view,c))){
        if(shutdown.signal.aborted)break;
        try{await runCandidate(workspace,`routine-${now().toISOString()}`,{action:c.action,target:c.target},shutdown.signal);}
        catch{/* already logged in plain words by runCandidate */}
      }
      view=ROUTINE.size?await state(workspace):view;
      // An `ask` candidate waits on a human, not on a model: its decision is
      // filed here (idempotent), so no gateway cycle starts for work the agent
      // must not do. On juno, four rebuilds read as hand-edited started a model
      // cycle every five minutes that ended on "no action", without a decision
      // ever reaching the panel.
      let filed=false;
      for(const c of view.candidates.filter((c)=>!ROUTINE.has(c.action)&&c.mode==='ask'&&!c.outsideWindow)){
        const candidate=clean(c);const previous=store.latestRequest(workspace,candidate.action,candidate.target);
        if(previous?.version===fingerprint(candidate)&&previous.status==='approved')continue;
        store.propose(workspace,candidate);filed=true;
      }
      if(filed)view=await state(workspace);
      const actionable=view.candidates.filter((c)=>!ROUTINE.has(c.action)&&c.mode!=='off'&&!c.outsideWindow&&!decided(view,c));
      if(!actionable.length)return;
      if(!host){degradedOnce(workspace,'maintenance_gateway_unavailable');return;}
      // Every model call of a gateway cycle is admitted by the manager. When the
      // day's model-call budget is used up, starting one can only produce a
      // failed cycle: wait for tomorrow, announced once, instead of retrying
      // every five minutes.
      const usedModelCalls=store.modelCallUsage(workspace);
      if(usedModelCalls>=p.limits.actionsPerDay){
        const message=`model-call budget for today is used up (${usedModelCalls}/${p.limits.actionsPerDay}); maintenance resumes tomorrow`;
        const last=store.relevantEvents(workspace,{kinds:['budget_exhausted']}).at(-1);
        if(last?.message!==`Maintenance: ${message}`)log(workspace,'budget_exhausted',message);
        return;
      }
      const id='maintenance-'+randomUUID();const secret=randomUUID();
      try{store.reserve({id,workspace,policy:p.version,kind:'cycles',cycle:id,limit:p.limits.cyclesPerDay});}
      catch(error){
        // Name the budget that refused: "the daily maintenance budget is used
        // up" left the reader unable to tell cycles from actions or calls.
        if(/^maintenance_budget_exhausted/.test(String(error.message))){degradedOnce(workspace,'daily cycle budget used up; maintenance resumes tomorrow');return;}
        throw error;
      }
      const cycle={id,workspace,status:'running',secret,at:now().toISOString()};store.cycle(cycle);
      const request={capability:'agent.maintain',operation:'run',objective:'Maintain the workspace using current facts and the allowed narrow actions. Human decisions are handled by the manager.',workspace:{name:workspace},model:activeProfileModel(ctx.session),language:ctx.session.language,mcp:activeProfileMcp(ctx.session),maintenance:{cycleId:id,endpoint:baseUrl,token:secret,policy:p}};
      const accepted=await host.runtimeProvider.execute(request);cycle.runId=accepted.runId;cycle.runtimeId=host.runtimeId;store.cycle(cycle);active.set(workspace,{cycle,provider:host.runtimeProvider});
      log(workspace,'cycle_started','cycle started',{cycleId:id});
      const unsubscribe=host.runtimeProvider.subscribe?.(cycle.runId,(event)=>{if(event.type==='degraded')log(workspace,'degraded',String(event.cause??'event transport degraded'),{cycleId:id});});active.get(workspace).unsubscribe=unsubscribe;
      void monitor(workspace,cycle,host.runtimeProvider);
    }catch(error){degradedOnce(workspace,error.message);}finally{scans.delete(workspace);}
  }
  async function monitor(workspace,cycle,provider) {
    
    try {
      for(;;){
        const result=await provider.status(cycle.runId);
        if(result.status==='recovering'){const ctx=await context(workspace);await provider.execute({capability:'agent.maintain',operation:'run',workspace:{name:workspace},model:activeProfileModel(ctx.session),language:ctx.session.language,mcp:activeProfileMcp(ctx.session),maintenance:{cycleId:cycle.id,endpoint:baseUrl,token:cycle.secret,policy:policy(workspace)}});}
        if(['completed','failed','cancelled'].includes(result.status)){
          cycle.status=result.status;cycle.result=result.result;store.cycle(cycle);store.settle(cycle.id);
          for(const r of store.reserved(workspace,{cycle:cycle.id,kind:'modelCalls'}))store.settle(r.id);
          if(result.result?.content)log(workspace,'summary',String(result.result.content).slice(0,16000),{cycleId:cycle.id});
          // A failed cycle says why: "cycle failed" alone left the reader (and Donna,
          // asked about it) with nothing to explain.
          const why=result.status==='completed'?'':describeError(result.error?.message??result.error??result.result?.error??'');
          log(workspace,result.status==='completed'?'cycle_done':'failure',`cycle ${result.status}${why?` — ${why}`:''}`,{cycleId:cycle.id,...(why?{detail:why}:{})});
          break;
        }
        await wait();
      }
    }catch(error){cycle.status='recovering';store.cycle(cycle);log(workspace,'degraded',`cycle monitoring interrupted: ${error.message}`,{cycleId:cycle.id});}
    finally{active.get(workspace)?.unsubscribe?.();active.delete(workspace);}
  }
  async function control(workspace,command,options={}) {
    if(command==='clear'){store.clearHistory(workspace);return status(workspace,options);}
    if(command==='resume'){store.pause(workspace,false);void tick(workspace);}
    if(['pause','stop'].includes(command))store.pause(workspace,true);
    if(command==='stop') {
      const ctx=await context(workspace);const item=active.get(workspace);if(item)await item.provider.cancel(item.cycle.runId);
      for(const reservation of store.reserved(workspace).filter((r)=>r.jobId)) {
        if(reservation.runtimeId){const external=capabilityRegistryForSession(ctx.session).providersFor('agent.curate').find((p)=>p.runtimeId===reservation.runtimeId);await external?.runtimeProvider?.cancel(reservation.jobId);continue;}
        await callTool(ctx.session.mcp,reservation.provider,'agent_cancel',{jobId:reservation.jobId});
        const status=jobState(parse(await callTool(ctx.session.mcp,reservation.provider,'agent_status',{jobId:reservation.jobId})));
        if(terminal(status.status)){if(status.lost)log(workspace,'stopped',`${reservation.candidate?.summary??'action'} — ${status.error}; nothing left to cancel`,{jobId:reservation.jobId});store.updateReservation(reservation.id,{outcome:'cancelled',result:status});store.settle(reservation.id);store.settle(reservation.id+':build');}
      }
      for(const reservation of store.reserved(workspace,{kind:'actions'})){
        if(!reservation.jobId&&reservation.dispatched)throw new Error('maintenance_stop_uncertain: an external dispatch must be reconciled before purge');
        if(!reservation.jobId){store.settle(reservation.id,{started:false});continue;}
        const provider=reservation.runtimeId?capabilityRegistryForSession(ctx.session).providersFor('agent.curate').find((p)=>p.runtimeId===reservation.runtimeId)?.runtimeProvider:null;
        const deadline=now().getTime()+CANCEL_CONFIRM_MS;
        for(;;){const result=provider?await provider.status(reservation.jobId):jobState(parse(await callTool(ctx.session.mcp,reservation.provider,'agent_status',{jobId:reservation.jobId})));if(terminal(result.status)){if(result.lost)log(workspace,'stopped',`${reservation.candidate?.summary??'action'} — ${result.error}; nothing left to cancel`,{jobId:reservation.jobId});store.updateReservation(reservation.id,{outcome:'cancelled',result});store.settle(reservation.id);store.settle(reservation.id+':build');break;}if(now().getTime()>deadline)throw new Error(`maintenance_cancel_unconfirmed: job ${reservation.jobId} did not end within ${CANCEL_CONFIRM_MS/1000} s of the stop`);await wait();}
      }
      for(const c of store.cycles(workspace).filter((c)=>['running','recovering'].includes(c.status))){
        const provider=item?.provider??capabilityRegistryForSession(ctx.session).providersFor('agent.maintain').find((p)=>p.runtimeProvider)?.runtimeProvider;
        if(!provider||!c.runId)throw new Error('maintenance_cycle_stop_uncertain');
        await provider.cancel(c.runId);const deadline=now().getTime()+CANCEL_CONFIRM_MS;for(;;){const result=await provider.status(c.runId);if(terminal(result.status)){c.status='cancelled';store.cycle(c);store.settle(c.id);break;}if(now().getTime()>deadline)throw new Error(`maintenance_cancel_unconfirmed: cycle ${c.runId} did not end within ${CANCEL_CONFIRM_MS/1000} s of the stop`);await wait();}
      }
      log(workspace,'stopped','stopped; pending decisions retained');
    }
    return status(workspace,options);
  }
  function status(workspace,options={}){const page=store.statusPage(workspace,options);const cycles=store.cycles(workspace).map(({secret,...c})=>c);let p,error;try{p=policy(workspace);}catch(e){error=e.message;}return {enabled:p?.enabled??false,paused:store.paused(workspace),mode:p?.mode??'custom',policyVersion:p?.version,actions:p?.actions??null,buildSchedule:p?.buildSchedule??null,error,...page,reservations:page.reservations.map(({candidate,...r})=>r),cycles,running:[...(live.get(workspace)?.values()??[])]};}
  // A human switch: Donna's tools never reach it (they only read, pause and stop).
  async function setEnabled(workspace,enabled){
    const doc=structuredClone(readDocument()??{});
    doc.maintenanceAccess??={defaults:{enabled:false},workspaces:{}};
    doc.maintenanceAccess.workspaces??={};
    doc.maintenanceAccess.workspaces[workspace]={...(doc.maintenanceAccess.workspaces[workspace]??{}),enabled};
    let next;
    try{next=maintenancePolicy(doc,workspace);}catch(error){throw new Error(`maintenance_policy_invalid: ${error.message}`);}
    writeEnabled(workspace,enabled);
    if(enabled){
      store.pause(workspace,false);
      const asks=Object.entries(next.actions).filter(([,m])=>m==='ask').map(([a])=>a);
      const offs=Object.entries(next.actions).filter(([,m])=>m==='off').map(([a])=>a);
      log(workspace,'enabled',`turned on by you for ${workspace}${next.mode?` in ${next.mode} mode.`:'.'}${next.mode==='human'?' Listed actions require your approval.':next.mode==='auto'?' Listed actions run without approval.':''}${asks.length?` It asks you first for: ${asks.join(', ')}.`:''}${offs.length?` Turned off: ${offs.join(', ')}.`:''}${next.buildSchedule?` Builds run between ${next.buildSchedule.start} and ${next.buildSchedule.end}.`:' Builds stay off until you set a build window (maintenanceAccess.buildSchedule).'}`);
      void tick(workspace);
    }else{
      log(workspace,'disabled',`turned off by you for ${workspace}; a job already running finishes, nothing new starts. Pending decisions are kept.`);
    }
    return status(workspace);
  }
  async function setMode(workspace,mode){
    if(!['auto','human'].includes(mode))throw new Error('maintenance_mode_invalid');
    const doc=structuredClone(readDocument()??{});
    doc.maintenanceAccess??={defaults:{enabled:false},workspaces:{}};
    doc.maintenanceAccess.workspaces??={};
    doc.maintenanceAccess.workspaces[workspace]={...(doc.maintenanceAccess.workspaces[workspace]??{}),mode};
    try{maintenancePolicy(doc,workspace);}catch(error){throw new Error(`maintenance_policy_invalid: ${error.message}`);}
    writeMode(workspace,mode);
    log(workspace,'mode_changed',`approval mode set to ${mode}; ${mode==='auto'?'listed actions run without approval':'listed actions wait for your approval'}`,{mode});
    if(policy(workspace).enabled)void tick(workspace);
    return status(workspace);
  }
  const isActive=(workspace)=>active.has(workspace)||inflight.has(workspace);
  const activeRuns=()=>[...new Set([...active.keys(),...inflight.keys()])].map((workspace)=>({workspace,runId:active.get(workspace)?.cycle?.id??'maintenance',kind:'maintenance'}));
  // The gateway's action bridge used to hold the HTTP request for the whole
  // job: a 44-source ingest outlived its 300 s header timeout, the gateway saw
  // "fetch failed" while the ingest went on, and the closed connection aborted
  // the manager's own follow-up. An action now runs on a ticket bound to the
  // runtime's lifetime, never to a connection; the gateway polls it.
  const tickets=new Map();
  function startCandidate(workspace,cycleId,input){
    for(const [key,entry] of tickets)if(entry.settledAt&&Date.now()-entry.settledAt>3_600_000)tickets.delete(key);
    const ticket=randomUUID();const entry={workspace,cycleId,status:'running'};tickets.set(ticket,entry);
    runCandidate(workspace,cycleId,input,shutdown.signal).then((result)=>{Object.assign(entry,{status:'settled',result,settledAt:Date.now()});},(error)=>{Object.assign(entry,{status:'failed',error:String(error?.message??error),settledAt:Date.now()});});
    return {status:'running',ticket};
  }
  function candidateTicket(cycleId,ticket){
    const entry=tickets.get(ticket);
    if(!entry||entry.cycleId!==cycleId)return {status:'unknown_ticket'};
    if(entry.status==='running')return {status:'running',ticket};
    tickets.delete(ticket);
    return entry.status==='failed'?{status:'failed',error:entry.error}:{status:'settled',result:entry.result};
  }
  return {store,state,tick,status,control,authorizeBridge,runCandidate,startCandidate,candidateTicket,modelAdmission,isActive,activeRuns,setEnabled,setMode,
    modelDone:(cycleId,call)=>{store.settle(`${cycleId}:model:${call}`);return {ok:true};},
    decide:async(w,id,v,approved)=>{if(approved){const requested=store.request(w,id);if(!requested)throw new Error('maintenance_request_unknown');const view=await state(w);const current=view.candidates.find((c)=>c.action===requested.action&&c.target===requested.target&&c.operation===requested.candidate.operation);const clean=current?Object.fromEntries(Object.entries(current).filter(([k])=>!['mode','outsideWindow'].includes(k))):null;if(!clean||fingerprint(clean)!==v){if(clean)store.propose(w,clean);throw new Error('maintenance_request_replaced_or_target_changed');}}const request=store.decide(w,id,v,approved);if(approved)void tick(w);return request;},
    start(){timer=setInterval(()=>{try{store.pruneLogs();}catch(e){console.error('Maintenance: log retention cleanup failed — '+e.message);}let doc;try{doc=readDocument();}catch{return;}for(const w of listWorkspaces()){try{if(maintenancePolicy(doc,w.name).enabled)void tick(w.name);}catch(e){log(w.name,'degraded',e.message);}}},Math.max(30_000,intervalMs||300_000));timer.unref?.();},
    // A runtime shutdown is not a user's Stop: it neither cancels the running jobs
    // nor pauses maintenance. The cycle is re-attached at the next boot (tick).
    async close(){clearInterval(timer);shutdown.abort();await Promise.allSettled([...ticking]);for(const item of active.values())item.unsubscribe?.();active.clear();},
  };
}
