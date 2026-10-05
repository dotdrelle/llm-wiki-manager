import { parse as parseYaml } from 'yaml';
/** @statuses-vocabulary
 * Maintenance cycles, reservations and independent provider jobs have their
 * own lifecycle; these statuses are not Donna DAG task statuses.
 */
import { readTaxoConceptPages, detectTaxoConflicts } from '../orchestrator/knowledgeSignals.js';
import { persistWorktreeProposal } from '../orchestrator/resultAggregator.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { maintenancePolicy, actionMode, inBuildWindow, MAINTENANCE_ACTIONS, fingerprint, describeReasons, describeError, fileNames } from './policy.js';
import { createMaintenanceStore } from './store.js';
import { readMaintenanceAccessDocument, setMaintenanceEnabled } from '../core/mcpEndpoints.js';
import { capabilityRegistryForSession } from '../orchestrator/capabilityRegistry.js';
import { discoverRuntimeProvidersOnce } from '../orchestrator/providers/runtimeProviders.js';
import { callMcpTool, formatMcpToolResult } from '../core/mcp.js';
import { activeProfileMcp, activeProfileModel, acceptsArgument } from '../orchestrator/dispatcher.js';
import { validateJsonSchema } from '../orchestrator/planValidator.js';
import { admitExecution, enableMaintenanceAdmission } from './admission.js';
import { listWorkspaces } from '../core/workspaces.js';

// Actions the manager runs itself, never through an agent cycle.
const ROUTINE=new Set(['sync','doctor','mail']);
// A deliverable edited by hand is never rebuilt without a human decision, even
// with build: auto — stabilize would merge or drop the edit before anyone saw it.
const modeFor=(p,c)=>{const mode=actionMode(p,c.action,c.target);return c.humanEdit&&mode==='auto'?'ask':mode;};
const terminal=(s)=>['done','completed','succeeded','failed','error','cancelled'].includes(s);
const parse=(r)=>{if(r?.content){const text=formatMcpToolResult(r);try{return JSON.parse(text);}catch{return parseYaml(text);}}return r;};
const wait=(signal)=>new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(signal.reason??new Error('aborted'));};const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},500);if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});});
export function createMaintenanceService({db,getContext,baseUrl,readDocument=readMaintenanceAccessDocument,callTool=callMcpTool,now=()=>new Date(),onEvent=null,discover=discoverRuntimeProvidersOnce,writeEnabled=setMaintenanceEnabled,intervalMs=Number(process.env.WIKI_MANAGER_MAINTENANCE_INTERVAL_MS??300_000)}) {
  const store=createMaintenanceStore(db);const active=new Map();const scans=new Set();const inflight=new Map();let timer;
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
    const refusedSources=store.requests(workspace).filter((r)=>r.status==='refused'&&r.action==='ingest').flatMap((r)=>r.candidate.args.maintenanceSelection??[]);
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
    const conflicts=detectTaxoConflicts(readTaxoConceptPages(ctx.session.workspacePath));
    if(conflicts.total>0||store.events(workspace).some((e)=>e.kind==='rebuild_owned'&&e.version===facts.wikiHash))add('rebuild','wiki',fingerprint(conflicts),{},`Rebuild the TAXO fiches and tag pages: ${conflicts.total} inconsistency(ies) found (a tag filed in several families, or a tag page citing no fiche)`);
    if(!facts.proposals?.length)add('curate','wiki',facts.wikiHash,{},'Review the wiki for duplicates, contradictions and unsourced claims, and prepare corrections for your review');
    const day=now().toISOString().slice(0,10);
    add('doctor','workspace',day,{},'Daily check of the workspace configuration and services');
    // Sync source names come from the connector's read-only configuration, never the model.
    try {
      const server=Object.entries(ctx.session.mcp??{}).find(([,entry])=>(entry.tools??[]).some((t)=>t.name==='cme_sources_list'))?.[0];
      if(server){const raw=parse(await callTool(ctx.session.mcp,server,'cme_sources_list',{workspace}));for(const source of raw.sources??(Array.isArray(raw)?raw:[])){const name=source.name??source.source_name;if(name)add('sync',String(name),String(Math.floor(now().getTime()/7_200_000)),{source_name:String(name)},`Synchronize the Confluence source ${name}`);}}
    }catch{log(workspace,'degraded','source configuration unavailable; synchronization skipped');}
    for(const f of facts.pending??[]){if(f.protected&&!store.events(workspace).some((e)=>e.kind==='protected_source'&&e.version===f.hash&&e.target===f.path))log(workspace,'protected_source',`${f.path} is waiting for human resolution (${f.reason})`,{version:f.hash,target:f.path});}
    const requests=store.requests(workspace);const reservations=store.reservations(workspace);
    // Mail is routine (no model): an alert for each new failure/decision batch,
    // and one digest per day for the previous day. Recipients come only from
    // maintenanceAccess.mail.to — the agent cannot name another one.
    if(p.mail.to.length){
      const events=store.events(workspace).filter((e)=>e.action!=='mail');
      const mailed=(to)=>Math.max(0,...store.reservations(workspace).filter((r)=>r.candidate?.action==='mail'&&r.candidate?.target===to&&r.status==='consumed'&&r.outcome==='done').map((r)=>Number(r.candidate.args?.uptoSeq??0)));
      const alertKinds=['failure','decision'].filter((k)=>p.mail.on.includes(k));
      const yesterday=new Date(now().getTime()-86_400_000).toISOString().slice(0,10);
      const digest=p.mail.on.includes('daily')?events.filter((e)=>e.at?.startsWith(yesterday)&&['action_done','failure','decision','protected_source','recommendation'].includes(e.kind)):[];
      for(const to of p.mail.to){
        const alerts=events.filter((e)=>alertKinds.includes(e.kind)&&e.seq>mailed(to));
        if(alerts.length){const upto=alerts.at(-1).seq;add('mail',to,`alert:${upto}`,{to,uptoSeq:upto,subject:`Wiki maintenance — ${workspace}: ${alerts.length} item(s) need attention`,body:alerts.slice(-20).map((e)=>e.message).join('\n')},`Email ${to} about ${alerts.length} failure(s) or decision(s)`);}
        if(digest.length)add('mail',to,`daily:${yesterday}`,{to,subject:`Wiki maintenance — ${workspace}: summary of ${yesterday}`,body:digest.slice(-50).map((e)=>e.message).join('\n')},`Email ${to} the summary of ${yesterday}`);
      }
    }
    // An action refused by its daily budget waits for tomorrow instead of looping.
    const budgetBlocked=new Set(store.events(workspace).filter((e)=>e.kind==='budget_exhausted'&&e.at?.startsWith(day)).map((e)=>e.identity));
    const available=candidates.filter((candidate)=>!budgetBlocked.has(fingerprint(candidate))&&!reservations.some((r)=>r.kind==='actions'&&(r.identity===fingerprint(candidate)||(candidate.action==='mail'&&r.candidate?.action==='mail'&&r.candidate?.target===candidate.target&&r.candidate?.version===candidate.version))&&r.status==='consumed'&&(r.outcome==='done'||(r.outcome==='failed'&&r.period===day))));
    // A failed action is not offered again the same day unless it changes (a new
    // identity): otherwise every scan would start a cycle that fails the same way.
    // The agent never sees routine work: the manager already runs it without a model.
    return {policy:p,paused:store.paused(workspace),facts,candidates:available.filter((c)=>!forAgent||!ROUTINE.has(c.action)).map((c)=>({...c,mode:modeFor(p,c),outsideWindow:c.action==='build'&&!inBuildWindow(p,now())})),requests,reservations,cycles:store.cycles(workspace).map(({secret,...c})=>c),events:store.events(workspace)};
  }
  function authorizeBridge(cycleId,token) {
    const cycle=db.prepare('SELECT payload FROM maintenance_cycles WHERE id=?').get(cycleId);
    if(!cycle)return null;const data=JSON.parse(cycle.payload);const a=Buffer.from(String(data.secret??''));const b=Buffer.from(String(token??''));
    return a.length&&a.length===b.length&&timingSafeEqual(a,b)&&['running','recovering'].includes(data.status)?data:null;
  }
  async function runCandidate(workspace,cycleId,input,signal) {
    if(!MAINTENANCE_ACTIONS[input.action])throw new Error('maintenance_unknown_action');
    let view=await state(workspace);let candidate=view.candidates.find((c)=>c.action===input.action&&c.target===input.target&&(input.operation==null||c.operation===input.operation));
    if(!candidate)throw new Error('maintenance_target_not_current');
    const {mode,outsideWindow,...clean}=candidate;candidate=clean;
    const p=policy(workspace);
    if(!p.enabled||store.paused(workspace))throw new Error('maintenance_disabled_or_paused');
    if(mode==='off'){log(workspace,'recommendation',`Suggested, not done (this action is turned off in maintenanceAccess): ${candidate.summary}`);return {status:'off'};}
    if(outsideWindow){log(workspace,'waiting',`${candidate.summary} — scheduled for the next build window`);return {status:'waiting'};}
    const identity=fingerprint(candidate);
    const held=store.reservations(workspace).find((r)=>r.kind==='actions'&&r.identity===identity&&r.status==='reserved');
    // One identity per candidate and day; a Stop that cancelled it opens a new
    // attempt, otherwise the cancelled outcome would be replayed forever.
    const base=fingerprint([workspace,candidate,now().toISOString().slice(0,10)]);
    const attempts=store.reservations(workspace).filter((r)=>r.kind==='actions'&&(r.id===base||r.id.startsWith(`${base}:retry-`)));
    const last=attempts.at(-1);
    const id=held?.id??(last?.status==='consumed'&&last.outcome==='cancelled'?`${base}:retry-${attempts.length}`:base);const previous=store.requests(workspace).filter((r)=>r.action===candidate.action&&r.target===candidate.target).at(-1);
    let approved=previous?.version===identity&&previous.status==='approved';
    if(mode==='ask'&&!approved){const request=store.propose(workspace,candidate);return {status:request.status,request:{id:request.id,version:request.version,summary:candidate.summary}};}
    const ctx=await context(workspace);const spec=MAINTENANCE_ACTIONS[candidate.action];
    const operation=candidate.operation??spec.operation;let provider=providerFor(ctx.session,candidate.action,operation);
    // Only actions that touch the workspace take an admission, scoped to what they
    // touch; a read, a worktree curation or a mail never holds a user's task.
    const scopes=spec.scopes?.(candidate.target)??null;
    let release=()=>{};
    if(scopes){
      enableMaintenanceAdmission(workspace);
      // Existing foreground work is registered before we request a conflicting start.
      if(ctx.running&&(ctx.session.headlessPlan??[]).some((t)=>!terminal(t.status))){log(workspace,'waiting',`${candidate.summary} — waiting: your run in progress goes first`);return {status:'waiting',reason:'foreground_run_pending'};}
      release=await admitExecution(workspace,{locks:scopes},{background:true,signal,label:`maintenance: ${candidate.summary}`,onWait:(holders)=>log(workspace,'waiting',`${candidate.summary} — waiting for ${holders}`)});
    }
    let reserved=false,started=false;
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
      const existing=store.reservations(workspace).find((r)=>r.id===id);
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
        // Persist dispatch intent before any external effect. Idempotent agents
        // reconcile an unknown response using the identical request/key.
        store.updateReservation(id,{dispatched:true,provider:provider.serverName,runtimeId:provider.runtimeId});started=true;
        let response;
        if(provider.runtimeProvider){
          response=await provider.runtimeProvider.execute({capability:spec.capability,operation,objective:candidate.summary,workspace:{name:workspace},model:activeProfileModel(ctx.session),language:ctx.session.language,mcp:activeProfileMcp(ctx.session)});
          response={accepted:true,jobId:response.runId};
        }else response=parse(await callTool(ctx.session.mcp,provider.serverName,'agent_execute',{taskId:id,runId:cycleId,capability:spec.capability,operation,arguments:args,workspace:{name:workspace},idempotencyKey:id,constraints:{requireApprovalForMutations:true}},signal));
        if(response.accepted===false){started=false;throw new Error(response.error?.message??'maintenance_execution_refused');}
        job=response.jobId;
        if(!job)throw new Error('maintenance_execution_receipt_missing');
        store.updateReservation(id,{jobId:job});
      } else started=true;
      let result;
      do{signal?.throwIfAborted();result=provider.runtimeProvider?await provider.runtimeProvider.status(job):parse(await callTool(ctx.session.mcp,provider.serverName,'agent_status',{jobId:job},signal));if(!terminal(result.status??result.result?.status))await wait(signal);}while(!terminal(result.status??result.result?.status));
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
        log(workspace,'interrupted',`${candidate.summary} — ${why}`,{cycleId,action:candidate.action});
      }
      else if(/^maintenance_budget_exhausted/.test(String(error.message)))log(workspace,'budget_exhausted',`${candidate.summary} — waiting until tomorrow: ${describeError(error.message)}`,{cycleId,action:candidate.action,identity,detail:error.message});
      else log(workspace,'failure',`${candidate.summary} — not done: ${describeError(error.message)}`,{cycleId,action:candidate.action,detail:error.message});
      throw error;
    }finally{release();const left=(inflight.get(workspace)??1)-1;if(left>0)inflight.set(workspace,left);else inflight.delete(workspace);}
  }
  function completeJob(workspace,ctx,id,result,cycleId,wikiHash) {
    const reservation=store.reservations(workspace).find((r)=>r.id===id);
    if(!reservation)throw new Error('unknown_reservation');
    if(reservation.status!=='reserved')return reservation.outcome;
    const status=result.status??result.result?.status;
    const outcome=['done','completed','succeeded'].includes(status)?'done':status==='cancelled'?'cancelled':'failed';
    const candidate=reservation.candidate;
    if(result.result?.worktreeProposal){const persisted=persistWorktreeProposal(ctx.session,result,{runId:cycleId,taskId:id});if(persisted.error)throw new Error(persisted.error);}
    if(result.result?.curationOutcome?.kind==='rebuild_owned')log(workspace,'rebuild_owned','curation findings belong to a TAXO rebuild',{version:wikiHash??candidate.version});
    store.updateReservation(id,{outcome,result});store.settle(id);
    if(candidate.action==='build')store.settle(id+':build');
    for(const request of store.requests(workspace).filter((r)=>outcome!=='cancelled'&&r.version===reservation.identity&&r.status==='approved'))db.prepare('UPDATE maintenance_requests SET status=? WHERE id=?').run(outcome,request.id);
    log(workspace,outcome==='done'?'action_done':outcome==='cancelled'?'interrupted':'failure',`${outcome==='done'?'Done':outcome==='cancelled'?'Cancelled':'Failed'}: ${candidate.summary}${outcome==='failed'&&(result.error?.message||result.result?.error)?` — ${describeError(result.error?.message??result.result?.error)}`:''}`,{cycleId,action:candidate.action,jobId:reservation.jobId});
    return outcome;
  }
  // A completed job can remove its own candidate (e.g. it archived Pending).
  // Reconcile persistent receipts before detecting new work, not through that
  // candidate list. An unknown effect retains its credit and blocks new starts.
  async function reconcile(workspace,ctx) {
    let settled=true;
    for(const r of store.reservations(workspace).filter((r)=>r.kind==='actions'&&r.status==='reserved')) {
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
        }else result=parse(await callTool(ctx.session.mcp,r.provider,'agent_status',{jobId:r.jobId},shutdown.signal));
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
      const actionable=view.candidates.filter((c)=>!ROUTINE.has(c.action)&&c.mode!=='off'&&!c.outsideWindow&&!decided(view,c));
      if(!actionable.length)return;
      if(!host){degradedOnce(workspace,'maintenance_gateway_unavailable');return;}
      const id='maintenance-'+randomUUID();const secret=randomUUID();
      store.reserve({id,workspace,policy:p.version,kind:'cycles',cycle:id,limit:p.limits.cyclesPerDay});
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
          for(const r of store.reservations(workspace).filter((r)=>r.cycle===cycle.id&&r.kind==='modelCalls'&&r.status==='reserved'))store.settle(r.id);
          if(result.result?.content)log(workspace,'summary',String(result.result.content).slice(0,16000),{cycleId:cycle.id});
          log(workspace,result.status==='completed'?'cycle_done':'failure',`cycle ${result.status}`,{cycleId:cycle.id});break;
        }
        await wait();
      }
    }catch(error){cycle.status='recovering';store.cycle(cycle);log(workspace,'degraded',`cycle monitoring interrupted: ${error.message}`,{cycleId:cycle.id});}
    finally{active.get(workspace)?.unsubscribe?.();active.delete(workspace);}
  }
  async function control(workspace,command) {
    if(command==='resume'){store.pause(workspace,false);void tick(workspace);}
    if(['pause','stop'].includes(command))store.pause(workspace,true);
    if(command==='stop') {
      const ctx=await context(workspace);const item=active.get(workspace);if(item)await item.provider.cancel(item.cycle.runId);
      for(const reservation of store.reservations(workspace).filter((r)=>r.status==='reserved'&&r.jobId)) {
        if(reservation.runtimeId){const external=capabilityRegistryForSession(ctx.session).providersFor('agent.curate').find((p)=>p.runtimeId===reservation.runtimeId);await external?.runtimeProvider?.cancel(reservation.jobId);continue;}
        await callTool(ctx.session.mcp,reservation.provider,'agent_cancel',{jobId:reservation.jobId});
        const status=parse(await callTool(ctx.session.mcp,reservation.provider,'agent_status',{jobId:reservation.jobId}));
        if(terminal(status.status)){store.updateReservation(reservation.id,{outcome:'cancelled',result:status});store.settle(reservation.id);store.settle(reservation.id+':build');}
      }
      for(const reservation of store.reservations(workspace).filter((r)=>r.kind==='actions'&&r.status==='reserved')){
        if(!reservation.jobId&&reservation.dispatched)throw new Error('maintenance_stop_uncertain: an external dispatch must be reconciled before purge');
        if(!reservation.jobId){store.settle(reservation.id,{started:false});continue;}
        const provider=reservation.runtimeId?capabilityRegistryForSession(ctx.session).providersFor('agent.curate').find((p)=>p.runtimeId===reservation.runtimeId)?.runtimeProvider:null;
        for(;;){const result=provider?await provider.status(reservation.jobId):parse(await callTool(ctx.session.mcp,reservation.provider,'agent_status',{jobId:reservation.jobId}));if(terminal(result.status)){store.updateReservation(reservation.id,{outcome:'cancelled',result});store.settle(reservation.id);store.settle(reservation.id+':build');break;}await wait();}
      }
      for(const c of store.cycles(workspace).filter((c)=>['running','recovering'].includes(c.status))){
        const provider=item?.provider??capabilityRegistryForSession(ctx.session).providersFor('agent.maintain').find((p)=>p.runtimeProvider)?.runtimeProvider;
        if(!provider||!c.runId)throw new Error('maintenance_cycle_stop_uncertain');
        await provider.cancel(c.runId);for(;;){const result=await provider.status(c.runId);if(terminal(result.status)){c.status='cancelled';store.cycle(c);store.settle(c.id);break;}await wait();}
      }
      log(workspace,'stopped','stopped; pending decisions retained');
    }
    return status(workspace);
  }
  function status(workspace){const cycles=store.cycles(workspace).map(({secret,...c})=>c);let p,error;try{p=policy(workspace);}catch(e){error=e.message;}return {enabled:p?.enabled??false,paused:store.paused(workspace),policyVersion:p?.version,error,requests:store.requests(workspace),reservations:store.reservations(workspace).map(({candidate,...r})=>r),cycles,events:store.events(workspace)};}
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
      log(workspace,'enabled',`turned on by you for ${workspace}.${asks.length?` It asks you first for: ${asks.join(', ')}.`:''}${offs.length?` Turned off: ${offs.join(', ')}.`:''}${next.buildSchedule?` Builds run between ${next.buildSchedule.start} and ${next.buildSchedule.end}.`:' Builds stay off until you set a build window (maintenanceAccess.buildSchedule).'}`);
      void tick(workspace);
    }else{
      log(workspace,'disabled',`turned off by you for ${workspace}; a job already running finishes, nothing new starts. Pending decisions are kept.`);
    }
    return status(workspace);
  }
  const isActive=(workspace)=>active.has(workspace)||inflight.has(workspace);
  const activeRuns=()=>[...new Set([...active.keys(),...inflight.keys()])].map((workspace)=>({workspace,runId:active.get(workspace)?.cycle?.id??'maintenance',kind:'maintenance'}));
  return {store,state,tick,status,control,authorizeBridge,runCandidate,modelAdmission,isActive,activeRuns,setEnabled,
    modelDone:(cycleId,call)=>{store.settle(`${cycleId}:model:${call}`);return {ok:true};},
    decide:async(w,id,v,approved)=>{if(approved){const requested=store.requests(w).find((r)=>r.id===id);if(!requested)throw new Error('maintenance_request_unknown');const view=await state(w);const current=view.candidates.find((c)=>c.action===requested.action&&c.target===requested.target&&c.operation===requested.candidate.operation);const clean=current?Object.fromEntries(Object.entries(current).filter(([k])=>!['mode','outsideWindow'].includes(k))):null;if(!clean||fingerprint(clean)!==v){if(clean)store.propose(w,clean);throw new Error('maintenance_request_replaced_or_target_changed');}}const request=store.decide(w,id,v,approved);if(approved)void tick(w);return request;},
    start(){timer=setInterval(()=>{let doc;try{doc=readDocument();}catch{return;}for(const w of listWorkspaces()){try{if(maintenancePolicy(doc,w.name).enabled)void tick(w.name);}catch(e){log(w.name,'degraded',e.message);}}},Math.max(30_000,intervalMs||300_000));timer.unref?.();},
    // A runtime shutdown is not a user's Stop: it neither cancels the running jobs
    // nor pauses maintenance. The cycle is re-attached at the next boot (tick).
    async close(){clearInterval(timer);shutdown.abort();await Promise.allSettled([...ticking]);for(const item of active.values())item.unsubscribe?.();active.clear();},
  };
}
