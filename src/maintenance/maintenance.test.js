import test from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { maintenancePolicy,actionMode,inBuildWindow,MAINTENANCE_ACTIONS,describeError,fingerprint } from './policy.js';
import { createMaintenanceStore } from './store.js';
import { admitExecution,enableMaintenanceAdmission } from './admission.js';
import { createMaintenanceService } from './service.js';
import { maintenanceDelta, applyMaintenanceUpdate } from '../core/maintenanceUpdates.js';
const setup=()=>{const db=new DatabaseSync(':memory:');return {db,store:createMaintenanceStore(db)};};
test('policy defaults protect first ingest and publication and use the configured default build window',()=>{const p=maintenancePolicy({},'x');assert.equal(p.enabled,false);assert.equal(actionMode(p,'ingest','x'),'ask');assert.equal(actionMode(p,'deliver','x'),'ask');assert.deepEqual(p.buildSchedule,{mode:'window',start:'12:00',end:'14:00',timezone:'Europe/Paris'});assert.equal(inBuildWindow(p,new Date('2026-10-05T12:00:00Z')),false);});
test('maintenance status exposes the effective workspace actions and build window',async()=>{const h=harness();try{h.policy({maintenanceAccess:{defaults:{enabled:true,actions:{ingest:'off',build:['templates/acpi.md']},buildSchedule:{mode:'window',start:'22:00',end:'03:00',timezone:'Europe/Paris'}},workspaces:{x:{actions:{doctor:'ask'}}}}});const status=h.service.status('x');assert.equal(status.actions.ingest,'off');assert.deepEqual(status.actions.build,['templates/acpi.md']);assert.equal(status.actions.doctor,'ask');assert.equal(status.buildSchedule.start,'22:00');assert.equal(status.buildSchedule.timezone,'Europe/Paris');}finally{await h.service.close();h.db.close();}});
test('clear history removes logs and finished cycles while retaining pending decisions and active cycles',()=>{const {db,store}=setup();try{store.event('x',{kind:'failure',message:'old log'});store.cycle({id:'finished',workspace:'x',status:'failed'});store.cycle({id:'active',workspace:'x',status:'running'});store.propose('x',{action:'ingest',target:'raw/a.md',summary:'Pending source'});const result=store.clearHistory('x');assert.deepEqual(result,{events:2,cycles:1});assert.equal(store.events('x').length,0);assert.deepEqual(store.cycles('x').map((cycle)=>cycle.id),['active']);assert.equal(store.requests('x').filter((request)=>request.status==='pending').length,1);}finally{db.close();}});
test('workspace overrides inherit and explicit target lists never authorize others',()=>{const p=maintenancePolicy({maintenanceAccess:{defaults:{enabled:true},workspaces:{x:{actions:{build:['templates/a.md']}}}}},'x');assert.equal(actionMode(p,'build','templates/a.md'),'auto');assert.equal(actionMode(p,'build','templates/b.md'),'off');assert.equal(p.actions.ingest,'ask');});
test('policy rejects invalid modes, paths, limits, mail and windows',()=>{for(const defaults of [{actions:{build:['../a']}},{limits:{buildsPerDay:-1}},{mail:{to:['invalid']}},{buildSchedule:{mode:'window',start:'99:00',end:'02:00'}}])assert.throws(()=>maintenancePolicy({maintenanceAccess:{defaults}},'x'));});
test('midnight windows use explicit timezone',()=>{const p=maintenancePolicy({maintenanceAccess:{defaults:{buildSchedule:{mode:'window',start:'22:00',end:'03:00',timezone:'UTC'}}}},'x');assert.equal(inBuildWindow(p,new Date('2026-10-05T23:00Z')),true);assert.equal(inBuildWindow(p,new Date('2026-10-05T12:00Z')),false);});
test('reservations count in-flight admissions and unknown previous-day effects',()=>{const {db,store}=setup();try{store.reserve({id:'a',workspace:'x',policy:'v',kind:'actions',cycle:'c',limit:1,period:'yesterday'});assert.throws(()=>store.reserve({id:'b',workspace:'x',policy:'v',kind:'actions',cycle:'d',limit:1}),/budget/);store.settle('a');store.settle('a');assert.equal(store.reservations('x')[0].status,'consumed');store.reserve({id:'b',workspace:'x',policy:'v',kind:'actions',cycle:'d',limit:1});}finally{db.close();}});
test('a certain pre-dispatch refusal releases capacity; retry reserves it again',()=>{const {db,store}=setup();try{const r={id:'a',workspace:'x',policy:'v',kind:'actions',cycle:'c',limit:1};store.reserve(r);store.settle('a',{started:false});assert.equal(store.reserve({...r,cycle:'d'}).status,'reserved');assert.throws(()=>store.reserve({...r,id:'b'}),/budget/);}finally{db.close();}});
test('new content replaces the old decision; stale approval and cross-workspace decisions fail',()=>{const {db,store}=setup();try{const a=store.propose('x',{action:'ingest',target:'raw',version:'1',summary:'first'});const b=store.propose('x',{action:'ingest',target:'raw',version:'2',summary:'second'});assert.throws(()=>store.decide('x',a.id,a.version,true),/replaced/);assert.throws(()=>store.decide('y',b.id,b.version,true));store.decide('x',b.id,b.version,false);assert.equal(store.propose('x',b.candidate).status,'refused');assert.equal(store.requests('x').filter(r=>r.status==='pending').length,0);}finally{db.close();}});
test('foreground pending before background admission wins the resource',async()=>{const w='priority';enableMaintenanceAdmission(w);const held=await admitExecution(w,{locks:['*']},{background:true});const order=[];const fore=admitExecution(w,{locks:['*']}).then(release=>{order.push('foreground');release();});const back=admitExecution(w,{locks:['*']},{background:true}).then(release=>{order.push('background');release();});held();await Promise.all([fore,back]);assert.deepEqual(order,['foreground','background']);});
test('aborted waiter does not steal or leak admission',async()=>{enableMaintenanceAdmission('abort');const held=await admitExecution('abort',{},{background:true});const c=new AbortController();const pending=admitExecution('abort',{},{background:true,signal:c.signal});c.abort();await assert.rejects(pending);held();(await admitExecution('abort',{},{background:true}))();});
test('disabled maintenance does not call tools or a model; scoped authority cannot approve',async()=>{const {db}=setup();let calls=0;const service=createMaintenanceService({db,getContext:async()=>{calls++;},readDocument:()=>({}),baseUrl:'http://localhost'});await service.tick('x');assert.equal(calls,0);assert.equal(service.authorizeBridge('unknown','token'),null);assert.equal(service.status('x').enabled,false);await service.close();db.close();});

function harness({facts:override={},runtime=null,gate=null,statuses=[],curate=null,onStatus=null,now=undefined,refuseExecute=null,cmeSources=null}={}){
  const {db}=setup();let version='a';let executions=[];const statusChecks=[];const cancels=[];let access={maintenanceAccess:{defaults:{enabled:true,limits:{sourceQuietMinutes:0}}}};
  const facts=()=>({wikiHash:'wiki',pending:[{path:'raw/untracked/a.md',hash:version,stable:true,protected:false}],index:{enabled:false,fresh:true},deliverables:[],publications:[],proposals:[],...override});
  const provider={serverName:'production',health:'available',capability:{supportedOperations:['ingest','doctor','index','ingest_rebuild','build','export','polish','send'],inputSchema:{type:'object',additionalProperties:true}}};
  const session={workspace:'x',workspacePath:'/private/tmp/nonexistent-maintenance-test',mcp:{wiki:{tools:[{name:'wiki_maintenance_state'}]},...(cmeSources?{cme:{tools:[{name:'cme_sources_list'}]}}:{})},capabilityRegistry:{providersFor:(capability)=>capability==='agent.maintain'?(runtime?[{runtimeProvider:runtime,runtimeId:'gw',health:'available',capability:{supportedOperations:['run']}}]:[]):capability==='agent.curate'&&curate?[{runtimeProvider:curate,runtimeId:'gw-curate',health:'available',capability:{supportedOperations:['run'],inputSchema:{type:'object',additionalProperties:true}}}]:[provider]}};
  const service=createMaintenanceService({db,baseUrl:'http://localhost',discover:async(session)=>{session.runtimeProviderAgents=[];},getContext:async()=>({session}),readDocument:()=>access,callTool:async(_mcp,_server,tool,args)=>{if(tool==='wiki_maintenance_state')return facts();if(tool==='cme_sources_list')return {sources:cmeSources.map((name)=>({name}))};if(tool==='agent_execute'){executions.push(args);if(refuseExecute)return {accepted:false,error:refuseExecute};return {accepted:true,jobId:'job-'+executions.length};}if(tool==='agent_status'){statusChecks.push(args.jobId);if(gate)await gate;if(onStatus)return onStatus(args.jobId,cancels);return {status:statuses.shift()??'done',result:{}};}if(tool==='agent_cancel'){cancels.push(args.jobId);return {ok:true};}throw new Error(tool);},...(now?{now}:{})});
  return {db,service,executions,statusChecks,cancels,provider,session,change:(v)=>{version=v;},policy:(p)=>{access=p;}};
}
test('pending ingestion does not prevent an independent diagnostic; approval is exact and dispatch reserves',async()=>{const h=harness();try{const pending=await h.service.runCandidate('x','cycle',{action:'ingest',target:'raw/untracked'});assert.equal(pending.status,'pending');assert.equal(h.executions.length,0);const doctor=await h.service.runCandidate('x','cycle',{action:'doctor',target:'workspace'});assert.equal(doctor.status,'done');await h.service.decide('x',pending.request.id,pending.request.version,true);const result=await h.service.runCandidate('x','cycle2',{action:'ingest',target:'raw/untracked'});assert.equal(result.status,'done');assert.equal(h.executions.length,2);assert.deepEqual(h.executions[1].arguments.maintenanceSelection,[{path:'raw/untracked/a.md',hash:'a'}]);assert.ok(h.service.store.reservations('x').every(r=>r.status==='consumed'));}finally{await h.service.close();h.db.close();}});
test('stale approval is rejected at decision time and replaced by current content',async()=>{const h=harness();try{const pending=await h.service.runCandidate('x','cycle',{action:'ingest',target:'raw/untracked'});h.change('b');await assert.rejects(h.service.decide('x',pending.request.id,pending.request.version,true),/replaced/);assert.equal(h.service.status('x').requests.filter(r=>r.status==='pending').length,1);assert.equal(h.executions.length,0);}finally{await h.service.close();h.db.close();}});
test('source refusal suppresses unchanged bytes but allows changed content',async()=>{const h=harness();try{const pending=await h.service.runCandidate('x','cycle',{action:'ingest',target:'raw/untracked'});await h.service.decide('x',pending.request.id,pending.request.version,false);assert.ok(!(await h.service.state('x')).candidates.some(c=>c.action==='ingest'));h.change('b');assert.ok((await h.service.state('x')).candidates.some(c=>c.action==='ingest'));}finally{await h.service.close();h.db.close();}});
test('revoking policy prevents a previously approved action',async()=>{const h=harness();try{const pending=await h.service.runCandidate('x','cycle',{action:'ingest',target:'raw/untracked'});await h.service.decide('x',pending.request.id,pending.request.version,true);h.policy({maintenanceAccess:{defaults:{enabled:false}}});await assert.rejects(h.service.runCandidate('x','cycle2',{action:'ingest',target:'raw/untracked'}),/disabled/);assert.equal(h.executions.length,0);}finally{await h.service.close();h.db.close();}});

test('routine sync/doctor run without a model; no gateway cycle when nothing else is due',async()=>{let launches=0;const runtime={execute:async()=>{launches++;return {runId:'r'};},status:async()=>({status:'completed'}),cancel:async()=>{}};const h=harness({facts:{pending:[],proposals:['p.json']},runtime});try{await h.service.tick('x');assert.deepEqual(h.executions.map(e=>e.operation),['doctor']);assert.equal(launches,0);}finally{await h.service.close();h.db.close();}});
test('the agent view never contains routine work',async()=>{const h=harness({facts:{pending:[],proposals:['p.json']}});try{assert.ok((await h.service.state('x')).candidates.some(c=>c.action==='doctor'));assert.ok(!(await h.service.state('x',{forAgent:true})).candidates.some(c=>c.action==='doctor'));}finally{await h.service.close();h.db.close();}});
test('maintenance only updates an export that already exists, never a first one',async()=>{const d={template:'templates/a.md',output:'deliverables/a.md',version:'v',fresh:true,reasons:[]};const none=harness({facts:{pending:[],deliverables:[{...d,artifacts:{export:false,polish:false}}]}});const some=harness({facts:{pending:[],deliverables:[{...d,artifacts:{export:true,polish:false}}]}});try{assert.ok(!(await none.service.state('x')).candidates.some(c=>c.action==='deliver'));const c=(await some.service.state('x')).candidates.find(c=>c.action==='deliver');assert.equal(c.operation,'export');assert.match(c.summary,/existing export/);}finally{for(const h of [none,some]){await h.service.close();h.db.close();}}});
test('a stale deliverable is explained in words, not reason codes',async()=>{const h=harness({facts:{pending:[],deliverables:[{template:'templates/a.md',output:'deliverables/a.md',version:'v',fresh:false,reasons:['knowledge_changed','output_modified'],artifacts:{}}]}});try{const c=(await h.service.state('x')).candidates.find(c=>c.action==='build');assert.match(c.summary,/the wiki content changed/);assert.doesNotMatch(c.summary,/knowledge_changed/);assert.match(describeError('maintenance_budget_exhausted'),/budget/);}finally{await h.service.close();h.db.close();}});
test('maintenance error descriptions extract structured errors instead of printing object tags',()=>{
  assert.match(describeError({message:'maintenance_target_not_current',status:409}),/situation changed/);
  assert.match(describeError({message:'maintenance_operation_not_current',status:409}),/operation does not match/i);
  assert.match(describeError({error:{code:'maintenance_gateway_unavailable'}}),/gateway.*not available/i);
  assert.doesNotMatch(describeError({message:'maintenance_target_not_current'}),/\[object Object\]/);
});
test('a runtime shutdown neither pauses maintenance nor cancels jobs',async()=>{const h=harness();await h.service.close();try{assert.equal(h.service.status('x').paused,false);}finally{h.db.close();}});
test('reads, worktree curation and mail never hold a user task',()=>{for(const a of ['doctor','curate','mail'])assert.equal(MAINTENANCE_ACTIONS[a].scopes,null);assert.deepEqual(MAINTENANCE_ACTIONS.sync.scopes('x'),['raw/untracked']);});
test('a foreground task waiting behind maintenance is announced with the holder',async()=>{const w='announce';enableMaintenanceAdmission(w);const held=await admitExecution(w,{locks:['workspace-write']},{background:true,label:'maintenance: Ingest 2 new source(s)'});const heard=[];const fore=admitExecution(w,{locks:['deliverable:a']},{onWait:(names)=>heard.push(names)});await new Promise(r=>setTimeout(r,150));held();(await fore)();assert.deepEqual(heard,['maintenance: Ingest 2 new source(s)']);});
test('a hand-edited deliverable is never rebuilt without a decision, even with build: auto',async()=>{const h=harness({facts:{pending:[],deliverables:[{template:'templates/a.md',output:'deliverables/a.md',version:'v',fresh:false,reasons:['output_modified'],artifacts:{}}]}});try{h.policy({maintenanceAccess:{defaults:{enabled:true,actions:{build:'auto'},buildSchedule:{mode:'window',start:'00:00',end:'23:59',timezone:'UTC'},limits:{sourceQuietMinutes:0}}}});const c=(await h.service.state('x')).candidates.find(c=>c.action==='build');assert.equal(c.mode,'ask');const r=await h.service.runCandidate('x','cycle',{action:'build',target:'templates/a.md'});assert.equal(r.status,'pending');assert.equal(h.executions.length,0);}finally{await h.service.close();h.db.close();}});
test('mail is routine: one alert per new failure batch, recipients only from the policy',async()=>{const h=harness({facts:{pending:[],proposals:['p.json']}});try{h.policy({maintenanceAccess:{defaults:{enabled:true,mail:{to:['ops@example.org'],on:['failure']},limits:{sourceQuietMinutes:0}}}});h.service.store.event('x',{kind:'failure',message:'Maintenance: Failed: export'});const mails=(await h.service.state('x')).candidates.filter(c=>c.action==='mail');assert.equal(mails.length,1);assert.equal(mails[0].target,'ops@example.org');assert.ok(!(await h.service.state('x',{forAgent:true})).candidates.some(c=>c.action==='mail'));await h.service.tick('x');assert.ok(h.executions.some(e=>e.operation==='send'&&e.arguments.to==='ops@example.org'));assert.ok(!(await h.service.state('x')).candidates.some(c=>c.action==='mail'),'the same alert is not sent twice');}finally{await h.service.close();h.db.close();}});
test('an executing maintenance action counts as an active run',async()=>{let release;const gate=new Promise(r=>{release=r;});const h=harness({facts:{pending:[],proposals:['p.json']},gate});try{assert.equal(h.service.isActive('x'),false);const running=h.service.runCandidate('x','cycle',{action:'doctor',target:'workspace'});for(let i=0;i<50&&!h.service.isActive('x');i++)await new Promise(r=>setTimeout(r,10));assert.equal(h.service.isActive('x'),true);assert.deepEqual(h.service.activeRuns().map(r=>r.kind),['maintenance']);release();await running;assert.equal(h.service.isActive('x'),false);}finally{await h.service.close();h.db.close();}});
test('a scan on a fresh context waits for the first runtime discovery',async()=>{let discovered=0;const {db}=setup();const session={workspace:'x',mcp:{wiki:{tools:[{name:'wiki_maintenance_state'}]}},capabilityRegistry:{providersFor:()=>[]}};const service=createMaintenanceService({db,baseUrl:'http://localhost',discover:async(s)=>{discovered++;s.runtimeProviderAgents=[];},getContext:async()=>({session}),readDocument:()=>({maintenanceAccess:{defaults:{enabled:true}}}),callTool:async()=>({wikiHash:'w',pending:[],deliverables:[],publications:[],proposals:['p']})});try{await service.tick('x');await service.tick('x');assert.equal(discovered,1);}finally{await service.close();db.close();}});
test('an action cancelled by a Stop runs again after resume',async()=>{const h=harness({facts:{pending:[],index:{enabled:true,fresh:false},proposals:['p.json']}});try{const c=(await h.service.state('x')).candidates.find(c=>c.action==='index');const {mode,outsideWindow,...clean}=c;const base=fingerprint(['x',clean,new Date().toISOString().slice(0,10)]);h.service.store.reserve({id:base,workspace:'x',policy:'v',kind:'actions',cycle:'c0',limit:40,payload:{identity:fingerprint(clean),candidate:clean,jobId:'old'}});h.service.store.updateReservation(base,{outcome:'cancelled'});h.service.store.settle(base);const r=await h.service.runCandidate('x','c1',{action:'index',target:'wiki'});assert.equal(r.status,'done');assert.equal(h.executions.length,1);}finally{await h.service.close();h.db.close();}});
test('a failed action is not offered again the same day',async()=>{const h=harness({facts:{pending:[],index:{enabled:true,fresh:false},proposals:['p.json']},statuses:['failed']});try{const r=await h.service.runCandidate('x','c1',{action:'index',target:'wiki'});assert.equal(r.status,'failed');assert.ok(!(await h.service.state('x')).candidates.some(c=>c.action==='index'));}finally{await h.service.close();h.db.close();}});
test('enable is a human switch: validated, announced with what it implies, never a Donna tool',async()=>{const {db}=setup();let doc={maintenanceAccess:{defaults:{enabled:false,buildSchedule:null},workspaces:{}}};const writes=[];const session={workspace:'x',mcp:{},capabilityRegistry:{providersFor:()=>[]}};const service=createMaintenanceService({db,baseUrl:'http://localhost',discover:async(s)=>{s.runtimeProviderAgents=[];},getContext:async()=>({session}),readDocument:()=>doc,writeEnabled:(w,e)=>{writes.push([w,e]);doc={maintenanceAccess:{...doc.maintenanceAccess,workspaces:{...doc.maintenanceAccess.workspaces,[w]:{enabled:e}}}};},callTool:async()=>({wikiHash:'w',pending:[],deliverables:[],publications:[],proposals:['p']})});try{service.store.pause('x',true);const st=await service.setEnabled('x',true);assert.deepEqual(writes,[['x',true]]);assert.equal(st.enabled,true);assert.equal(st.paused,false);const msg=st.events.find(e=>e.kind==='enabled').message;assert.match(msg,/asks you first for: ingest, deliver/);assert.match(msg,/Builds stay off until you set a build window/);doc={maintenanceAccess:{defaults:{enabled:false,limits:{buildsPerDay:-1}}}};await assert.rejects(service.setEnabled('x',true),/maintenance_policy_invalid/);assert.equal(writes.length,1,'an invalid policy is never written');}finally{await service.close();db.close();}
const graph=await import('../agent/graph.js');const names=JSON.stringify(Object.values(graph).filter(v=>Array.isArray(v)));assert.doesNotMatch(names,/maintenance_enable|maintenance_disable/);});
test('an action refused by its daily budget waits for tomorrow instead of looping',async()=>{const h=harness({facts:{pending:[],index:{enabled:true,fresh:false},proposals:['p.json']}});try{h.policy({maintenanceAccess:{defaults:{enabled:true,limits:{actionsPerDay:0,sourceQuietMinutes:0}}}});await assert.rejects(h.service.runCandidate('x','c',{action:'index',target:'wiki'}),/budget/);assert.ok(!(await h.service.state('x')).candidates.some(c=>c.action==='index'));assert.match(h.service.status('x').events.at(-1).message,/waiting until tomorrow/);}finally{await h.service.close();h.db.close();}});

test('alert watermark stays internal with the closed communication.send-email schema',async()=>{
  const h=harness({facts:{pending:[],proposals:['p']}});
  try {
    h.provider.capability.inputSchema={type:'object',required:['to','subject','body'],properties:{to:{type:'string'},subject:{type:'string'},body:{type:'string'}},additionalProperties:false};
    h.policy({maintenanceAccess:{defaults:{enabled:true,mail:{to:['ops@example.org'],on:['failure']}}}});
    h.service.store.event('x',{kind:'failure',message:'Maintenance: export failed'});
    const result=await h.service.runCandidate('x','mail-cycle',{action:'mail',target:'ops@example.org'});
    assert.equal(result.status,'done');assert.equal(h.executions.length,1);
    assert.deepEqual(Object.keys(h.executions[0].arguments).sort(),['body','subject','to']);
    assert.ok(h.service.store.reservations('x')[0].candidate.args.uptoSeq>0);
    assert.ok(!(await h.service.state('x')).candidates.some(c=>c.action==='mail'));
  }finally{await h.service.close();h.db.close();}
});
test('successive export settings changes create distinct work and replace outdated approvals',async()=>{
  const facts={pending:[],proposals:['p'],deliverables:[{template:'templates/a.md',output:'deliverables/a.md',version:'unchanged-source',fresh:true,reasons:[],artifacts:{export:true}}],publications:[{source:'deliverables/a.md',operation:'export',fresh:false,reason:'settings_changed'}],publicationTransforms:{export:'fr-v1'}};
  const h=harness({facts});
  try {
    const first=await h.service.runCandidate('x','c1',{action:'deliver',target:'deliverables/a.md',operation:'export'});
    facts.publicationTransforms.export='en-v1';
    await assert.rejects(h.service.decide('x',first.request.id,first.request.version,true),/replaced/);
    const pending=h.service.store.requests('x').find(r=>r.status==='pending');
    await h.service.decide('x',pending.id,pending.version,true);
    assert.equal((await h.service.runCandidate('x','c2',{action:'deliver',target:'deliverables/a.md',operation:'export'})).status,'done');
    assert.ok(!(await h.service.state('x')).candidates.some(c=>c.action==='deliver'));
    facts.publicationTransforms.export='de-v1';
    assert.ok((await h.service.state('x')).candidates.some(c=>c.action==='deliver'));
    const next=await h.service.runCandidate('x','c3',{action:'deliver',target:'deliverables/a.md',operation:'export'});
    assert.equal(next.status,'pending');assert.notEqual(next.request.version,pending.version);
  }finally{await h.service.close();h.db.close();}
});
test('finished receipts settle once even when their source candidate vanished',async()=>{
  const h=harness({facts:{pending:[],proposals:['p']}});
  try {
    h.policy({maintenanceAccess:{defaults:{enabled:true,actions:{doctor:'off'}}}});
    h.service.store.reserve({id:'lost-ingest',workspace:'x',policy:'v',kind:'actions',cycle:'old-cycle',limit:40,payload:{identity:'old-input',candidate:{action:'ingest',version:'v',summary:'Ingest archived sources'},provider:'production',dispatched:true,jobId:'completed-during-shutdown'}});
    await h.service.tick('x');await h.service.tick('x');
    assert.deepEqual(h.statusChecks,['completed-during-shutdown']);assert.equal(h.executions.length,0);
    assert.equal(h.service.store.reservations('x')[0].status,'consumed');
    assert.equal(h.service.store.events('x').filter(e=>e.kind==='action_done').length,1);
  }finally{await h.service.close();h.db.close();}
});
test('running jobs retain budget and prevent new work even after their candidate vanishes',async()=>{
  const h=harness({facts:{pending:[],proposals:['p']},statuses:['running']});
  try {
    h.service.store.reserve({id:'running',workspace:'x',policy:'v',kind:'actions',cycle:'old-cycle',limit:40,payload:{candidate:{action:'ingest',summary:'Ingest'},provider:'production',dispatched:true,jobId:'still-running'}});
    await h.service.tick('x');assert.equal(h.executions.length,0);
    assert.equal(h.service.store.reservations('x')[0].status,'reserved');
  }finally{await h.service.close();h.db.close();}
});
test('unknown effects retain credits and block starts; never-dispatched reservations release',async()=>{
  const h=harness({facts:{pending:[],proposals:['p']}});
  try {
    for(const [id,dispatched] of [['unknown',true],['never-dispatched',false]])h.service.store.reserve({id,workspace:'x',policy:'v',kind:'actions',cycle:'old-cycle',limit:40,payload:{candidate:{action:'doctor'},dispatched}});
    await h.service.tick('x');assert.equal(h.executions.length,0);
    assert.equal(h.service.store.reservations('x').find(r=>r.id==='unknown').status,'reserved');
    assert.equal(h.service.store.reservations('x').find(r=>r.id==='never-dispatched').status,'released');
  }finally{await h.service.close();h.db.close();}
});
test('new model invocations consume distinct credits; retries and duplicated settlements are idempotent',async()=>{
  const h=harness();try {
    h.policy({maintenanceAccess:{defaults:{enabled:true,limits:{actionsPerDay:2}}}});
    const a=randomUUID(),b=randomUUID();
    h.service.modelAdmission('x','cycle',a);h.service.modelDone('cycle',a);
    h.service.modelAdmission('x','cycle',a);h.service.modelDone('cycle',a);
    h.service.modelAdmission('x','cycle',b);h.service.modelDone('cycle',b);
    assert.equal(h.service.store.reservations('x').filter(r=>r.kind==='modelCalls'&&r.status==='consumed').length,2);
    assert.throws(()=>h.service.modelAdmission('x','cycle',randomUUID()),/budget/);
  }finally{await h.service.close();h.db.close();}
});
test('capability withdrawal during admission refuses the stale provider before dispatch',async()=>{
  const h=harness({facts:{pending:[],index:{enabled:true,fresh:false},proposals:['p']}});enableMaintenanceAdmission('x');
  const release=await admitExecution('x',{locks:['workspace-write']});
  try {
    const action=h.service.runCandidate('x','cycle',{action:'index',target:'wiki'});
    for(let i=0;i<100&&!h.service.store.events('x').some(e=>e.kind==='waiting');i++)await new Promise(r=>setTimeout(r,5));
    assert.ok(h.service.store.events('x').some(e=>e.kind==='waiting'));
    h.session.capabilityRegistry={providersFor:()=>[]};release();
    await assert.rejects(action,/capability_unavailable/);assert.equal(h.executions.length,0);
  }finally{release();await h.service.close();h.db.close();}
});

test('mail cursors are computed once per snapshot and only successful sends advance them',async()=>{
  const h=harness({facts:{pending:[],proposals:['p']}});
  try {
    h.policy({maintenanceAccess:{defaults:{enabled:true,mail:{to:['a@example.invalid','b@example.invalid'],on:['failure']}}}});
    const first=h.service.store.event('x',{kind:'failure',message:'first'});
    const second=h.service.store.event('x',{kind:'failure',message:'second'});
    for(const [id,to,outcome,uptoSeq] of [['sent','a@example.invalid','done',first.seq],['failed','b@example.invalid','failed',second.seq],['cancelled','a@example.invalid','cancelled',second.seq]]){
      h.service.store.reserve({id,workspace:'x',policy:'v',kind:'actions',cycle:'c',limit:100,payload:{candidate:{action:'mail',target:to,args:{uptoSeq}},outcome}});
      h.service.store.settle(id);
    }
    let reads=0;const original=h.service.store.reservations;
    h.service.store.reservations=(w)=>{reads++;return original(w);};
    const view=await h.service.state('x');
    assert.equal(reads,0);
    const alerts=view.candidates.filter(c=>c.action==='mail');
    assert.equal(alerts.length,2);
    assert.equal(alerts.find(c=>c.target==='a@example.invalid').args.body,'second');
    assert.equal(alerts.find(c=>c.target==='b@example.invalid').args.body,'first\nsecond');
    assert.ok(alerts.every(c=>c.args.uptoSeq===second.seq));
  }finally{await h.service.close();h.db.close();}
});

test('status pages retain every active request and reservation without losing older settled history',()=>{
  const {db,store}=setup();
  try {
    for(let i=0;i<6;i++){
      const r=store.propose('x',{action:'doctor',target:'t'+i,version:'v',summary:'s'+i});store.decide('x',r.id,r.version,false);
      store.reserve({id:'r'+i,workspace:'x',kind:'actions',policy:'v',cycle:'c',limit:100});store.settle('r'+i);
    }
    const pending=store.propose('x',{action:'build',target:'pending',version:'v'});
    const approved=store.propose('x',{action:'build',target:'approved',version:'v'});store.decide('x',approved.id,approved.version,true);
    store.reserve({id:'live',workspace:'x',kind:'actions',policy:'v',cycle:'c',limit:100});
    store.propose('other',{action:'doctor',target:'foreign',version:'v'});
    const collected=new Set();
    for(const offset of [0,2,4]){
      const page=store.statusPage('x',{historyOffset:offset,historyLimit:2});
      assert.equal(page.requests.length,4);assert.equal(page.reservations.length,3);
      assert.ok(page.requests.some(r=>r.id===pending.id));assert.ok(page.requests.some(r=>r.id===approved.id));
      assert.ok(page.reservations.some(r=>r.id==='live'));
      for(const r of page.requests.filter(r=>r.status==='refused'))collected.add(r.id);
      assert.equal(page.history.hasMore,offset+2<page.history.eventsTotal);assert.equal(page.history.requestsTotal,6);
    }
    assert.equal(collected.size,6);
    assert.match(db.prepare('EXPLAIN QUERY PLAN SELECT * FROM maintenance_reservations WHERE workspace=?').all('x').map(r=>r.detail).join(' '),/USING INDEX/);
    assert.equal(store.request('other',pending.id),undefined);
  }finally{db.close();}
});


test('maintenance log retention is a sliding window across workspaces and preserves decisions and budgets',()=>{
  const db=new DatabaseSync(':memory:');let time=new Date('2026-10-05T12:00:00Z');
  const store=createMaintenanceStore(db,{now:()=>time,retentionDays:15});
  try {
    const insert=db.prepare('INSERT INTO maintenance_events(workspace,payload) VALUES(?,?)');
    insert.run('x',JSON.stringify({at:'2026-09-20T11:59:59Z',message:'expired'}));
    insert.run('other',JSON.stringify({at:'2026-09-20T11:59:59Z',message:'expired dormant workspace'}));
    insert.run('x',JSON.stringify({at:'2026-09-20T12:00:00Z',message:'exact cutoff'}));
    const request=store.propose('x',{action:'ingest',target:'raw',version:'v'});
    store.reserve({id:'active',workspace:'x',kind:'actions',policy:'v',cycle:'c',limit:10});
    store.reserve({id:'done',workspace:'x',kind:'actions',policy:'v',cycle:'c',limit:10});store.settle('done');
    assert.ok(store.events('x').some(e=>e.message==='exact cutoff'));
    assert.ok(!store.events('x').some(e=>e.message==='expired'));
    assert.equal(store.events('other').length,0);
    time=new Date('2026-10-05T12:00:01Z');
    assert.ok(!store.events('x').some(e=>e.message==='exact cutoff'));
    assert.equal(store.request('x',request.id).status,'pending');
    assert.equal(store.reservations('x').length,2);
  }finally{db.close();}
});

test('recent maintenance logs survive volume and older retained pages remain readable',()=>{
  const db=new DatabaseSync(':memory:');const time=new Date('2026-10-05T12:00:00Z');
  const store=createMaintenanceStore(db,{now:()=>time,retentionDays:2});
  try {
    db.exec('BEGIN');const insert=db.prepare('INSERT INTO maintenance_events(workspace,payload) VALUES(?,?)');
    for(let i=0;i<1205;i++)insert.run('x',JSON.stringify({at:time.toISOString(),message:'entry-'+i}));db.exec('COMMIT');
    store.event('x',{message:'latest'});
    assert.equal(db.prepare('SELECT COUNT(*) n FROM maintenance_events').get().n,1206);
    assert.equal(store.events('x').length,1000);assert.equal(store.events('x').at(-1).message,'latest');
    const latest=store.statusPage('x');assert.equal(latest.events.length,100);assert.equal(latest.history.eventsTotal,1206);assert.equal(latest.history.hasMore,true);
    const oldest=store.statusPage('x',{historyOffset:1200});assert.equal(oldest.events.length,6);assert.equal(oldest.events[0].message,'entry-0');assert.equal(oldest.history.hasMore,false);
    assert.ok(latest.events[0].seq>oldest.events.at(-1).seq);
    assert.equal(latest.history.retentionDays,2);
  }finally{db.close();}
});

test('maintenance stream deltas roundtrip changes and reject a missed revision',()=>{
  const before={enabled:true,requests:[{id:'a',status:'pending'}],reservations:[],cycles:[],events:[{seq:1,message:'one'}],history:{eventsTotal:1}};
  const after={enabled:true,paused:true,requests:[{id:'a',status:'approved'},{id:'b',status:'pending'}],reservations:[],cycles:[{id:'c',status:'running'}],events:[{seq:1,message:'one'},{seq:2,message:'two'}],history:{eventsTotal:2}};
  const delta=maintenanceDelta(before,after);const update={kind:'delta',epoch:'e',baseRevision:4,revision:5,delta};
  const applied=applyMaintenanceUpdate({...before,stream:{epoch:'e',revision:4}},update);
  const {stream,...value}=applied;assert.deepEqual(value,after);assert.deepEqual(stream,{epoch:'e',revision:5});
  assert.equal(applyMaintenanceUpdate(applied,update),applied,'duplicate older revisions are ignored');
  assert.throws(()=>applyMaintenanceUpdate(applied,{...update,baseRevision:3,revision:6}),/gap/);
  const restarted=applyMaintenanceUpdate(applied,{kind:'snapshot',epoch:'next',revision:1,snapshot:before});
  assert.equal(restarted.stream.epoch,'next');assert.equal(restarted.stream.revision,1);
});

test('a failed mail send never feeds its own next alert',async()=>{
  const h=harness({facts:{pending:[],proposals:[]},statuses:['failed']});
  try {
    h.policy({maintenanceAccess:{defaults:{enabled:true,mail:{to:['ops@example.org'],on:['failure']},limits:{sourceQuietMinutes:0}}}});
    h.service.store.event('x',{kind:'failure',message:'Maintenance: Failed: export'});
    const alert=(await h.service.state('x')).candidates.find((c)=>c.action==='mail');
    assert.ok(alert);
    const sent=await h.service.runCandidate('x','cycle',{action:'mail',target:'ops@example.org'});
    assert.equal(sent.status,'failed');
    assert.ok(!(await h.service.state('x')).candidates.some((c)=>c.action==='mail'),'the failed send is not quoted back into a retry loop');
  }finally{await h.service.close();h.db.close();}
});

test('the daily digest covers yesterday only and never the mail action itself',()=>{
  const {db,store}=setup();
  try {
    const insert=db.prepare('INSERT INTO maintenance_events(workspace,payload) VALUES(?,?)');
    insert.run('x',JSON.stringify({kind:'action_done',action:'mail',at:'2026-10-04T09:00:00.000Z',message:'mail sent'}));
    insert.run('x',JSON.stringify({kind:'action_done',at:'2026-10-04T10:00:00.000Z',message:'export done'}));
    insert.run('x',JSON.stringify({kind:'action_done',at:'2026-10-05T08:00:00.000Z',message:'today'}));
    const digest=store.relevantEvents('x',{kinds:['action_done'],since:'2026-10-04',before:'2026-10-05',excludeAction:'mail'});
    assert.deepEqual(digest.map((e)=>e.message),['export done']);
  }finally{db.close();}
});

test('a curation run by maintenance shows its collective roles while it runs',async()=>{
  // Polling status() alone drew one bare node for the whole curation: the
  // roles reach the run graph only through the runtime's event stream.
  let listener=null,unsubscribed=false,seen=null,polls=0;
  const curate={execute:async()=>({runId:'curate-roles'}),
    subscribe:(runId,fn)=>{assert.equal(runId,'curate-roles');listener=fn;return ()=>{unsubscribed=true;};},
    status:async()=>{
      if(polls++===0){
        listener({type:'subagent_started',subagent:'scout'});
        listener({type:'subagent_finished',subagent:'scout'});
        listener({type:'subagent_started',subagent:'analyst'});
        listener({type:'tool_finished',tool:'wiki_read_page'});
        seen=h.service.status('x').running[0];
        return {status:'running'};
      }
      return {status:'completed',result:{content:'ok',curationOutcome:{kind:'nothing_to_curate',reason:'test'}}};
    },cancel:async()=>{}};
  const h=harness({facts:{pending:[],proposals:[]},curate});
  try {
    const candidate=(await h.service.state('x')).candidates.find((c)=>c.action==='curate');
    await h.service.runCandidate('x','cycle',{action:'curate',target:candidate.target});
    assert.deepEqual(seen.progress.roles,[{name:'scout',status:'done'},{name:'analyst',status:'running'}]);
    // The action keeps its own title: the role line is a detail.
    assert.equal(seen.progress.label,undefined);
    assert.match(seen.progress.detail,/analyst/);
    assert.equal(unsubscribed,true,'the stream is released when the action ends');
  }finally{await h.service.close();h.db.close();}
});

test('a curation with no source fiche is announced as not started, never as done',async()=>{
  const curate={execute:async()=>({runId:'curate-1'}),status:async()=>({status:'completed',result:{content:'no sources',curationOutcome:{kind:'nothing_to_curate',reason:'No wiki/sources fiche exists yet; ingest first.'}}}),cancel:async()=>{}};
  const h=harness({facts:{pending:[],proposals:[]},curate});
  try {
    const candidate=(await h.service.state('x')).candidates.find((c)=>c.action==='curate');
    assert.ok(candidate);
    const result=await h.service.runCandidate('x','cycle',{action:'curate',target:candidate.target});
    assert.equal(result.status,'done');
    const events=h.service.store.events('x');
    assert.ok(events.some((e)=>e.kind==='nothing_to_curate'&&/Ingest source documents first/.test(e.message)));
    assert.ok(!events.some((e)=>e.kind==='action_done'),'a skipped curation is never reported as done');
  }finally{await h.service.close();h.db.close();}
});

test('an irrelevant operation on a current curate target is identified as an operation mismatch',async()=>{
  const h=harness({facts:{pending:[],proposals:[]}});
  try {
    const candidate=(await h.service.state('x')).candidates.find((c)=>c.action==='curate');
    assert.ok(candidate);
    await assert.rejects(h.service.runCandidate('x','cycle',{action:'curate',target:candidate.target,operation:'export'}),/maintenance_operation_not_current/);
    assert.equal(h.executions.length,0);
  }finally{await h.service.close();h.db.close();}
});

// ── The user has priority over maintenance ───────────────────────────────────
const indexFacts={pending:[],index:{enabled:true,fresh:false},proposals:['p.json']};
const untilCancelled=(jobId,cancels)=>({status:cancels.includes(jobId)?'cancelled':'running',result:{}});
const waitFor=async(predicate)=>{for(let i=0;i<100&&!predicate();i++)await new Promise((r)=>setTimeout(r,20));assert.ok(predicate());};
test('a foreground request preempts a preemptible holder once, and says so',async()=>{
  const w='preempt-admission';enableMaintenanceAdmission(w);const asked=[];
  const held=await admitExecution(w,{locks:['workspace-write']},{background:true,label:'maintenance: index',onPreempt:(by)=>{asked.push(by);setTimeout(held,50);}});
  const heard=[];(await admitExecution(w,{locks:['deliverable:a']},{label:'Ingest 3 files',onWait:(names,info)=>heard.push(info.preempting)}))();
  assert.deepEqual(asked,['Ingest 3 files']);assert.deepEqual(heard,[true]);
});
test('a user request pauses a running maintenance job, returns its credit, and the next scan replays it',async()=>{
  const h=harness({facts:indexFacts,onStatus:untilCancelled});enableMaintenanceAdmission('x');
  try{
    const run=h.service.runCandidate('x','c1',{action:'index',target:'wiki'});
    await waitFor(()=>h.executions.length===1);
    const release=await admitExecution('x',{locks:['workspace-write']},{label:'Ingest 3 files'});
    const result=await run;release();
    assert.equal(result.status,'preempted');assert.deepEqual(h.cancels,['job-1']);
    const attempt=h.service.store.reservations('x').find((r)=>r.kind==='actions');
    assert.equal(attempt.status,'released');assert.equal(attempt.outcome,'cancelled');
    assert.ok(h.service.store.events('x').some((e)=>/paused so your Ingest 3 files goes first/.test(e.message)));
    const again=h.service.runCandidate('x','c2',{action:'index',target:'wiki'});
    await waitFor(()=>h.executions.length===2);
    assert.notEqual(h.executions[1].idempotencyKey,h.executions[0].idempotencyKey);
    (await admitExecution('x',{locks:['workspace-write']},{label:'stop'}))();await again;
  }finally{await h.service.close();h.db.close();}
});
test('a maintenance action past its time limit is stopped and reported as such',async()=>{
  let offset=0;const now=()=>new Date(Date.parse('2026-10-06T10:00:00Z')+offset);
  const h=harness({facts:indexFacts,now,onStatus:(jobId,cancels)=>{offset+=61*60_000;return untilCancelled(jobId,cancels);}});
  try{
    const result=await h.service.runCandidate('x','c1',{action:'index',target:'wiki'});
    assert.equal(result.status,'failed');assert.deepEqual(h.cancels,['job-1']);
    assert.ok(h.service.store.events('x').some((e)=>/stopped after 60 min without finishing/.test(e.message)));
  }finally{await h.service.close();h.db.close();}
});
test('a request queued by the user keeps maintenance from starting',async()=>{
  const h=harness({facts:indexFacts});h.session.controlQueue=[{id:'q',status:'queued'}];
  try{
    const result=await h.service.runCandidate('x','c1',{action:'index',target:'wiki'});
    assert.deepEqual([result.status,result.reason],['waiting','foreground_queue_pending']);assert.equal(h.executions.length,0);
  }finally{await h.service.close();h.db.close();}
});
test('a refused action is not retried at every scan the same day',async()=>{
  const h=harness({facts:indexFacts,refuseExecute:'export already running'});
  try{
    await assert.rejects(h.service.runCandidate('x','c1',{action:'index',target:'wiki'}),/export already running/);
    const failure=h.service.store.events('x').filter((e)=>e.kind==='failure').at(-1);
    assert.equal(typeof failure.identity,'string');
    assert.ok(!(await h.service.state('x')).candidates.some((c)=>c.action==='index'),'the refused identity waits for tomorrow');
  }finally{await h.service.close();h.db.close();}
});
test('an exhausted model-call budget waits for tomorrow instead of starting doomed cycles',async()=>{
  let launches=0;const runtime={execute:async()=>{launches++;return {runId:'r'};},status:async()=>({status:'completed'}),cancel:async()=>{}};
  const h=harness({facts:indexFacts,runtime});
  try{
    h.policy({maintenanceAccess:{defaults:{enabled:true,limits:{actionsPerDay:2,sourceQuietMinutes:0}}}});
    for(let i=0;i<2;i++){h.service.store.reserve({id:'m'+i,workspace:'x',policy:'v',kind:'modelCalls',cycle:'c'+i,limit:1000});h.service.store.settle('m'+i);}
    await h.service.tick('x');
    assert.equal(launches,0,'no gateway cycle is started');
    assert.match(h.service.store.events('x').filter((e)=>e.kind==='budget_exhausted').at(-1).message,/model-call budget/);
    await h.service.tick('x');
    assert.equal(h.service.store.events('x').filter((e)=>/model-call budget/.test(e.message)).length,1,'announced once');
  }finally{await h.service.close();h.db.close();}
});
test('a cycle stopped by the model-call budget says why instead of a bare failure',async()=>{
  const runtime={execute:async()=>({runId:'r'}),status:async()=>({status:'failed',error:'maintenance_budget_exhausted'}),cancel:async()=>{}};
  const h=harness({facts:indexFacts,runtime});
  try{
    await h.service.tick('x');
    let failed;
    for(let i=0;i<100&&!failed;i++){
      failed=h.service.store.events('x').find((e)=>e.kind==='failure'&&/cycle failed/.test(e.message));
      if(!failed)await new Promise((r)=>setTimeout(r,10));
    }
    assert.ok(failed,'the cycle failure is logged');
    assert.match(failed.message,/cycle failed — .*budget/i);
  }finally{await h.service.close();h.db.close();}
});
test('a per-cycle budget refusal is retried at the next scan, not blocked for the day',async()=>{
  const h=harness({facts:indexFacts});
  try{
    h.policy({maintenanceAccess:{defaults:{enabled:true,limits:{actionsPerCycle:1,sourceQuietMinutes:0}}}});
    assert.equal((await h.service.runCandidate('x','c1',{action:'doctor',target:'workspace'})).status,'done');
    await assert.rejects(h.service.runCandidate('x','c1',{action:'index',target:'wiki'}),/maintenance_budget_exhausted:cycle/);
    assert.ok((await h.service.state('x')).candidates.some((c)=>c.action==='index'),'the next cycle may still run it');
    assert.ok(!h.service.store.events('x').some((e)=>e.kind==='budget_exhausted'&&e.action==='index'),'no day-level block');
    assert.ok(h.service.store.events('x').some((e)=>e.kind==='waiting'&&e.action==='index'));
  }finally{await h.service.close();h.db.close();}
});
test('a failed action shows the gateway reason even when the agent reports a plain string',async()=>{
  const curate={execute:async()=>({runId:'c1'}),status:async()=>({status:'failed',error:'gateway token budget exceeded (590475 > 500000); the run is stopped before the next model call'}),cancel:async()=>{}};
  const h=harness({facts:{pending:[],proposals:[]},curate});
  try{
    const candidate=(await h.service.state('x')).candidates.find((c)=>c.action==='curate');
    const result=await h.service.runCandidate('x','cycle',{action:'curate',target:candidate.target});
    assert.equal(result.status,'failed');
    const failure=h.service.store.events('x').filter((e)=>e.kind==='failure').at(-1);
    assert.match(failure.message,/token budget exceeded/);
  }finally{await h.service.close();h.db.close();}
});
test('human mode asks once for a sync, never once per Confluence source',async()=>{const h=harness({facts:{pending:[],proposals:['p.json']},cmeSources:['page-a','page-b','page-c']});try{h.policy({maintenanceAccess:{defaults:{enabled:true,mode:'human',limits:{sourceQuietMinutes:0}}}});const syncs=(await h.service.state('x')).candidates.filter(c=>c.action==='sync');assert.equal(syncs.length,1);assert.equal(syncs[0].mode,'ask');assert.match(syncs[0].summary,/3 Confluence source\(s\): page-a, page-b, page-c/);assert.deepEqual(syncs[0].args,{},'no source_name: the connector exports every source');await h.service.tick('x');const asked=h.service.status('x').requests.filter(r=>r.status==='pending'&&r.action==='sync');assert.equal(asked.length,1);assert.ok(!h.executions.some(e=>e.operation==='export'));}finally{await h.service.close();h.db.close();}});
test('a running maintenance action is published with its agent progress, then removed',async()=>{let release;const gate=new Promise(r=>{release=r;});let calls=0;const h=harness({facts:{pending:[],proposals:['p.json']},onStatus:async()=>{calls++;if(calls===1)return {status:'running',progress:{label:'Doctor',percent:40}};await gate;return {status:'done',result:{}};}});try{const running=h.service.runCandidate('x','cycle',{action:'doctor',target:'workspace'});let live=[];for(let i=0;i<100&&!(live[0]?.progress);i++){await new Promise(r=>setTimeout(r,10));live=h.service.status('x').running;}assert.equal(live.length,1);assert.equal(live[0].action,'doctor');assert.equal(live[0].agent,'production');assert.ok(live[0].jobId);assert.deepEqual(live[0].progress,{label:'Doctor',percent:40});release();await running;assert.deepEqual(h.service.status('x').running,[]);}finally{await h.service.close();h.db.close();}});
test('a bridge action runs on a ticket, independent of the request that started it',async()=>{let release;const gate=new Promise(r=>{release=r;});const h=harness({facts:{pending:[],proposals:['p.json']},gate});try{const started=h.service.startCandidate('x','cycle',{action:'doctor',target:'workspace'});assert.equal(started.status,'running');assert.ok(started.ticket);assert.equal(h.service.candidateTicket('other-cycle',started.ticket).status,'unknown_ticket');assert.equal(h.service.candidateTicket('cycle',started.ticket).status,'running');release();let state;for(let i=0;i<100;i++){state=h.service.candidateTicket('cycle',started.ticket);if(state.status!=='running')break;await new Promise(r=>setTimeout(r,10));}assert.equal(state.status,'settled');assert.equal(state.result.status,'done');assert.equal(h.service.candidateTicket('cycle',started.ticket).status,'unknown_ticket','a settled ticket is read once');}finally{await h.service.close();h.db.close();}});
test('a job its agent no longer knows ends the stop and the reconciliation instead of polling forever',async()=>{
  const h=harness({facts:{pending:[],proposals:['p']},onStatus:()=>({ok:false,error:'Unknown jobId: gone'})});
  try {
    h.service.store.reserve({id:'lost',workspace:'x',policy:'v',kind:'actions',cycle:'old-cycle',limit:40,payload:{candidate:{action:'ingest_rebuild',summary:'Rebuild'},provider:'production',dispatched:true,jobId:'gone'}});
    const stopped=await Promise.race([h.service.control('x','stop').then(()=>'stopped'),new Promise((r)=>setTimeout(()=>r('hung'),2000))]);
    assert.equal(stopped,'stopped');
    assert.equal(h.service.store.reservations('x').find(r=>r.id==='lost').status,'consumed');
    assert.ok(h.service.store.events('x').some((e)=>/no longer knows this job/.test(e.message)));
    h.service.store.reserve({id:'lost2',workspace:'x',policy:'v',kind:'actions',cycle:'old-cycle',limit:40,payload:{candidate:{action:'ingest',summary:'Ingest'},provider:'production',dispatched:true,jobId:'gone'}});
    h.service.store.pause('x',false);await h.service.tick('x');
    assert.equal(h.service.store.reservations('x').find(r=>r.id==='lost2').status,'consumed');
  }finally{await h.service.close();h.db.close();}
});
