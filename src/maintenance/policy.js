import { createHash } from 'node:crypto';
export const ACTIONS = ['sync','ingest','doctor','index','rebuild','curate','build','deliver','mail'];
export const DEFAULT_POLICY = {
  enabled: false, mode:null, actions: { sync:'auto', ingest:'ask', doctor:'auto', index:'auto', rebuild:'auto', curate:'auto', build:'auto', deliver:'ask', mail:'auto' },
  mail: { to: [], on: ['failure','decision','daily'] },
  limits: { cyclesPerDay:12, buildsPerDay:4, actionsPerDay:40, actionsPerCycle:10, sourceQuietMinutes:10 },
  buildSchedule: { mode:'window', start:'12:00', end:'14:00', timezone:'Europe/Paris' },
};
export const fingerprint = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function maintenancePolicy(document, workspace) {
  const block = document?.maintenanceAccess;
  if (!block) return { ...structuredClone(DEFAULT_POLICY), version: fingerprint(DEFAULT_POLICY) };
  if (typeof block !== 'object' || Array.isArray(block)) throw new Error('Invalid maintenanceAccess');
  const base = block.defaults ?? {}; const local = block.workspaces?.[workspace] ?? {};
  const defaultActions=structuredClone(DEFAULT_POLICY.actions);
  const normalizeActions=(value,fallback)=>Array.isArray(value)
    ? Object.fromEntries(ACTIONS.map((action)=>[action,value.includes(action)?'enabled':'off']))
    : {...fallback,...(value??{})};
  const baseActions=normalizeActions(base.actions,defaultActions);
  const actions=Array.isArray(local.actions)?normalizeActions(local.actions,baseActions):{...baseActions,...(local.actions??{})};
  const result = { ...structuredClone(DEFAULT_POLICY), ...base, ...local,
    actions,
    limits:{...DEFAULT_POLICY.limits,...base.limits,...local.limits},
    mail:{...DEFAULT_POLICY.mail,...base.mail,...local.mail} };
  if (typeof result.enabled !== 'boolean') throw new Error('Maintenance enabled must be boolean');
  if (result.mode !== null && !['auto','human'].includes(result.mode)) throw new Error('Maintenance mode must be auto or human');
  for (const [key,value] of Object.entries(result.actions)) {
    if (!ACTIONS.includes(key) || !( ['auto','ask','off','enabled'].includes(value) || ['build','deliver'].includes(key) && Array.isArray(value) && value.every((p) => typeof p === 'string' && /^(templates|deliverables)\//.test(p) && !p.split('/').includes('..')))) throw new Error(`Invalid maintenance action: ${key}`);
  }
  for (const [key,value] of Object.entries(result.limits)) if (!Object.hasOwn(DEFAULT_POLICY.limits,key) || !Number.isFinite(value) || value < 0 || value > 10000) throw new Error(`Invalid maintenance limit: ${key}`);
  if (!Array.isArray(result.mail.to) || !result.mail.to.every((v) => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))) throw new Error('Invalid maintenance recipients');
  if (!Array.isArray(result.mail.on) || result.mail.on.some((v) => !['failure','decision','daily'].includes(v))) throw new Error('Invalid maintenance mail events');
  const schedule=result.buildSchedule;
  if (schedule) {
    if (schedule.mode !== 'window' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.end)) throw new Error('Invalid maintenance build window');
    new Intl.DateTimeFormat('en',{timeZone:schedule.timezone}).format();
  }
  return {...result, version:fingerprint(result)};
}
export function actionMode(policy, action, target) {
  const mode=policy.actions[action] ?? 'off';
  if (mode === 'off') return 'off';
  if (Array.isArray(mode) && !mode.includes(target)) return 'off';
  // The MCP config's action map is the allow-list. The global mode decides
  // whether a listed action runs directly or waits for an explicit approval.
  if (policy.mode === 'auto') return 'auto';
  if (policy.mode === 'human') return 'ask';
  return Array.isArray(mode) || mode === 'enabled' ? 'auto' : mode;
}
export function inBuildWindow(policy, now=new Date()) {
  const s=policy.buildSchedule;if (!s) return false;
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:s.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(now);
  return s.start<=s.end ? parts>=s.start && parts<s.end : parts>=s.start || parts<s.end;
}
// `scopes` orders starts against Donna's dispatch (admission.js); null means the
// action never takes the workspace: a read (doctor), a worktree (curate) or an
// outbound message (mail) must not hold a user's production task behind it.
export const MAINTENANCE_ACTIONS = {
  sync:{capability:'external-source.export',operation:'export',scopes:()=>['raw/untracked']},
  ingest:{capability:'knowledge.update',operation:'ingest',scopes:()=>['workspace-write']},
  doctor:{capability:'workspace.diagnose',operation:'doctor',scopes:null},
  index:{capability:'knowledge.index',operation:'index',scopes:()=>['workspace-write']},
  rebuild:{capability:'knowledge.rebuild',operation:'ingest_rebuild',scopes:()=>['workspace-write']},
  curate:{capability:'agent.curate',operation:'run',scopes:null},
  build:{capability:'document.build',operation:'build',scopes:(target)=>[`template:${target}`]},
  deliver:{capability:'document.publish',operation:'export',scopes:(target)=>[`deliverable:${target}`]},
  mail:{capability:'communication.send-email',operation:'send',scopes:null},
};
// Readable wording for the engine's freshness reasons and the manager's own
// refusal codes: a log line is read by someone who does not know the codes.
const REASONS = {
  build_not_tracked:'it was never built by the engine',
  output_missing:'its file is missing',
  template_changed:'its template changed',
  knowledge_changed:'the wiki content changed',
  context_changed:'its build context changed',
  output_modified:'the file was edited by hand since the last build',
};
export const describeReasons=(reasons=[])=>reasons.map((r)=>REASONS[r]??r.replace(/_/g,' ')).join('; ');
const ERRORS = [
  [/^maintenance_policy_invalid: (.+)/,(m)=>`the maintenance settings are invalid (${m[1]}); fix maintenanceAccess in mcp.endpoints.json`],
  [/^maintenance_request_replaced|^maintenance_request_unknown/,'this request was replaced by a newer one or no longer exists; review the current request'],
  [/^maintenance_operation_not_current/,'the operation does not match the current maintenance candidate; review the latest candidate details'],
  [/^maintenance_target_not_current|^maintenance_target_changed/,'the situation changed before the action started; it will be re-evaluated on the next cycle'],
  [/^maintenance_budget_exhausted:day/,'the daily maintenance budget is used up; it resumes tomorrow'],
  [/^maintenance_budget_exhausted:cycle/,'the action budget of this cycle is reached; it resumes at the next scan'],
  [/^maintenance_policy_changed/,'the maintenance settings changed during the cycle'],
  [/^maintenance_disabled_or_paused/,'maintenance is disabled or paused'],
  [/^maintenance_capability_unavailable: (.+)/,(m)=>`no connected agent currently offers ${m[1]}`],
  [/^maintenance_gateway_unavailable/,'the agentic runtime (gateway) is not available, so no maintenance cycle can run'],
  [/^maintenance_state_tool_unavailable/,'the wiki engine is not reachable, so the workspace state cannot be read'],
  [/^maintenance_arguments_invalid/,'the agent refused the request format'],
  [/^maintenance_execution_receipt_missing/,'the agent accepted the job without returning its identifier'],
  [/^maintenance_dispatch_uncertain/,'an earlier start may have reached the agent; it is reconciled before any retry'],
  [/^maintenance_workspace_unavailable/,'the workspace is not loaded in the runtime'],
];
function errorText(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Error) return value.message || value.name;
  if (typeof value === 'object') {
    for (const key of ['message','error','reason','code','details']) {
      if (value[key] == null || value[key] === value) continue;
      const nested = errorText(value[key]);
      if (nested) return nested;
    }
    try { return JSON.stringify(value); } catch { return '[unreadable error details]'; }
  }
  return String(value);
}
export function describeError(message='') {
  const readable=errorText(message);
  for(const [pattern,text] of ERRORS){const m=readable.match(pattern);if(m)return typeof text==='function'?text(m):text;}
  return readable;
}
const fileNames=(paths,max=3)=>{const names=paths.map((p)=>String(p).split('/').pop());return names.length>max?`${names.slice(0,max).join(', ')} and ${names.length-max} more`:names.join(', ');};
export { fileNames };
