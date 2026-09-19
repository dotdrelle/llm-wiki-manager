import { createServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { conversationEventSequences, createAgentEvent, dispatchAgentEvent, resetSessionProjection, reduceAgentEvents } from '../core/agentEvents.js';
import { activeCacertPath } from '../core/cacert.js';
import { normalizePlanPatch, rebasePlanPatch } from '../core/planPatch.js';
import { validateContractInDev } from '../contracts/schemas.js';
import { runtimeTokenFromEnv } from './auth.js';
import { controlMessage } from './controlMessages.js';
import { tasksAwaitingApproval } from '../orchestrator/dependencyResolver.js';
import { isActive, isCancelled, isFailed, isSuccessful } from '../orchestrator/taskStatuses.js';
import { approvalClassForTask } from '../orchestrator/approvalPolicy.js';
import { RUNTIME_SHUTDOWN_ABORT_REASON } from '../orchestrator/dispatcher.js';
import {
  PROACTIVE_REVIEW_CAPABILITY,
  buildProactiveReviewObjective,
  createProactiveReviewScheduler,
} from '../orchestrator/proactiveReviewScheduler.js';
import { matchSkillInvocation } from '../core/skillInvocation.js';
import { reconcileControlQueue } from './controlDrain.js';
import { cancelControlChain, cancelQueuedControlItem } from './controlCancellation.js';
import { generateSkillAcknowledgment, runSkillChain } from './skillRun.js';
import { emitRuntimeLog } from './supervisor.js';
import { findSkill, listSkills } from '../core/skills.js';
import {
  enrollment,
  isLoopbackAddress,
  isTotpEnabled,
  issueSessionWithTotp,
  loginAttemptAllowed,
  loginStatus,
  pruneLoginAttempts,
  resetLoginAttempts,
  revokeSession,
  verifySessionToken,
} from './loginSession.js';
import { loginPageHtml } from './loginPage.js';

function loginErrorText(code) {
  const messages = {
    totp_disabled: 'TOTP login is disabled on this manager.',
    no_enrollment: 'Enrollment expired. Reload this page.',
    enrollment_requires_loopback: 'Enrollment must be done from the machine running the manager.',
    invalid_code: 'Invalid verification code.',
  };
  return messages[code] ?? 'Verification failed.';
}

const PRIVATE_CONTROL_INPUTS = new WeakMap();

function privateControlInputsFor(session) {
  if (!session || (typeof session !== 'object' && typeof session !== 'function')) return new Map();
  let inputs = PRIVATE_CONTROL_INPUTS.get(session);
  if (!inputs) {
    inputs = new Map();
    PRIVATE_CONTROL_INPUTS.set(session, inputs);
  }
  return inputs;
}

export function startRuntimeServer({
  host = '127.0.0.1',
  port = 7788,
  token = runtimeTokenFromEnv(),
  store,
  session = null,
  getContext,
  run,
  turn,
  delegate,
  cancel,
  resume,
  approve,
  configProfiles,
  useConfigProfile,
  listMcpEndpoints,
  upsertMcpEndpoint,
  deleteMcpEndpoint,
  listActiveRuns = null,
  exitOnShutdown = process.env.WIKI_MANAGER_RUNTIME_CHILD === '1',
} = {}) {
  const clients = new Set();
  // Deterministic dedup/cooldown/budget for proactive reviews; the run itself
  // stays the normal control-lane path.
  const proactiveScheduler = createProactiveReviewScheduler();
  // runId -> the review record that started it, so the slot is released exactly
  // once when the run reaches a terminal state (persisted or not).
  const proactiveRuns = new Map();
  // Compiled objectives are private execution material. They deliberately do
  // not enter events, projections, SSE, audit output or the runs table.
  // When this runtime process started — used by ensureRuntime to detect that
  // the manager source has been edited since (dev staleness) and auto-restart.
  const runtimeStartedAtMs = Date.now();
  const defaultContext = { workspace: null, session, running: false, currentAbortController: null, currentRunId: null };
  const resolvedGetContext = getContext ?? (() => defaultContext);

  function publish(event) {
    const payload = `event: agent_event\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      if (client.workspace && event.workspace !== client.workspace) continue;
      client.response.write(payload);
    }
  }

  function publishState(workspace = null, context = null) {
    for (const client of clients) {
      if (client.workspace && client.workspace !== workspace) continue;
      client.response.write(`event: state\ndata: ${JSON.stringify(runtimeState(context, store, { workspace, session }))}\n\n`);
    }
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

      // ── TOTP login surface — public by design: it is the door, not a room ──
      if (url.pathname === '/login' && request.method === 'GET') {
        const remoteAddress = request.socket?.remoteAddress ?? null;
        const current = enrollment();
        const status = loginStatus();
        if (!status.enabled) {
          sendHtml(response, 200, loginPageHtml({ error: 'TOTP login is disabled on this manager.' }));
          return;
        }
        if (!status.enrolled && !isLoopbackAddress(remoteAddress)) {
          sendHtml(response, 403, loginPageHtml({ error: 'Enrollment must be done from the machine running the manager.' }));
          return;
        }
        sendHtml(response, 200, loginPageHtml({
          enrolled: status.enrolled,
          secret: current?.secret ?? null,
          uri: current?.uri ?? null,
        }));
        return;
      }
      if (url.pathname === '/login/verify' && request.method === 'POST') {
        const remoteAddress = request.socket?.remoteAddress ?? null;
        const allowed = loginAttemptAllowed(remoteAddress);
        if (!allowed.ok) {
          sendJson(response, 429, { ok: false, error: `Too many attempts. Try again in ${allowed.retryAfterSeconds}s.` });
          return;
        }
        const body = await readJson(request).catch(() => ({}));
        const result = issueSessionWithTotp(body?.code, { remoteAddress });
        if (!result.ok) {
          sendJson(response, 401, { ok: false, error: loginErrorText(result.error) });
          return;
        }
        resetLoginAttempts(remoteAddress);
        // Hand the session to the browser as a cookie, on the runtime's own
        // origin. Cookies ignore the port, so a browser that logged in here
        // (the ShellUI gate) carries the same `wiki_session` to `serve` when
        // it runs on this host — one TOTP login for both surfaces. serve sets
        // its own cookie too when a browser reaches it first.
        setSessionCookie(response, result.token, result.expiresAt, request);
        sendJson(response, 200, {
          ok: true,
          token: result.token,
          expiresAt: result.expiresAt,
          page: loginPageHtml({ enrolled: true, sessionExpiresAt: result.expiresAt }),
        });
        return;
      }
      if (url.pathname === '/login/status' && request.method === 'GET') {
        sendJson(response, 200, { ok: true, ...loginStatus() });
        return;
      }
      if (url.pathname === '/logout' && request.method === 'POST') {
        const body = await readJson(request).catch(() => ({}));
        // revokeSession refuses without the session's own token — this route
        // sits before the bearer gate by design, so the token itself is the
        // only proof that the caller is the session being revoked, not an
        // unauthenticated third party forcing the operator out.
        const revoked = revokeSession(body?.token ?? null);
        sendJson(response, 200, { ok: true, revoked });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/session/verify') {
        // Public on purpose: the token IS the credential being checked — the
        // caller already holds it, so verifying it leaks nothing beyond what
        // possession implies. serve and the shell call this without bearer.
        const sessionToken = String(url.searchParams.get('token') ?? '').trim();
        const result = verifySessionToken(sessionToken);
        sendJson(response, 200, { ok: result.ok, ...result });
        return;
      }

      if (!isAuthorized(request, token)) {
        sendJson(response, 401, { error: 'Unauthorized' });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/health') {
        const workspace = workspaceFromUrl(url);
        const context = workspace ? await resolveContext({ workspace }) : null;
        // activeRuns spans ALL workspace contexts: the shell uses it at exit
        // to decide whether shutting down its own runtime would kill work.
        const activeRuns = typeof listActiveRuns === 'function' ? listActiveRuns() : [];
        sendJson(response, 200, {
          ok: true,
          status: context?.running ? 'running' : 'idle',
          workspace: context?.workspace ?? workspace ?? null,
          activeRuns,
          startedAtMs: runtimeStartedAtMs,
          dbPath: store.dbPath,
          cacertPath: activeCacertPath(),
          nodeExtraCaCerts: process.env.NODE_EXTRA_CA_CERTS ?? null,
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/state') {
        const workspace = workspaceFromUrl(url);
        const context = workspace ? await resolveContext({ workspace }) : null;
        sendJson(response, 200, runtimeState(context, store, { workspace, session }));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/events') {
        const workspace = workspaceFromUrl(url);
        sendJson(response, 200, { events: store.listEvents({ workspace }) });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/audit') {
        const workspace = workspaceFromUrl(url);
        const runId = url.searchParams.get('runId') ?? null;
        sendJson(response, 200, {
          ok: true,
          workspace,
          runId,
          audit: typeof store.listAuditTrail === 'function'
            ? store.listAuditTrail({ workspace, runId })
            : [],
        });
        return;
      }
      if (request.method === 'GET') {
        const taskRead = readTaskEndpoint(url);
        if (taskRead) {
          if (taskRead.kind === 'run_tasks') {
            sendJson(response, 200, {
              ok: true,
              runId: taskRead.runId,
              tasks: typeof store.listTasks === 'function' ? store.listTasks({ runId: taskRead.runId }) : [],
            });
            return;
          }
          if (taskRead.kind === 'task_attempts') {
            sendJson(response, 200, {
              ok: true,
              taskId: taskRead.taskId,
              attempts: typeof store.listTaskAttempts === 'function' ? store.listTaskAttempts({ taskId: taskRead.taskId }) : [],
            });
            return;
          }
          if (taskRead.kind === 'task_result') {
            sendJson(response, 200, {
              ok: true,
              taskId: taskRead.taskId,
              result: typeof store.getTaskResult === 'function' ? store.getTaskResult({ taskId: taskRead.taskId }) : null,
            });
            return;
          }
        }
      }
      if (request.method === 'GET' && url.pathname === '/control') {
        const workspace = workspaceFromUrl(url);
        const context = await resolveContext({ workspace });
        sendJson(response, 200, controlStatus(context, store));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/control') {
        const { body, context } = await resolveBodyContext(request, url);
        const action = String(body.action ?? 'status').trim().toLowerCase();
        if (action === 'status') {
          validateContractInDev('controlMessage', { ...body, action });
          sendJson(response, 200, controlStatus(context, store));
          return;
        }
        if (action === 'explain') {
          validateContractInDev('controlMessage', { ...body, action });
          const status = controlStatus(context, store);
          sendJson(response, 200, { ...status, explanation: explainControlState(status) });
          return;
        }
        if (action === 'message') {
          const input = String(body.input ?? body.message ?? body.prompt ?? body.request ?? '').trim();
          if (!input) {
            sendJson(response, 400, { error: 'Missing input.' });
            return;
          }
          validateContractInDev('controlMessage', { ...body, action, input });
          const result = await handleControlMessage(context, store, input, {
            intent: body.intent,
            startNextControlRequest,
            cancel,
            approve,
          });
          sendJson(response, result.statusCode, result.body);
          return;
        }
        if (action === 'approve_patch') {
          const patchId = readRequiredPatchId(body, response);
          if (!patchId) return;
          validateContractInDev('controlMessage', { ...body, action, patchId });
          const result = approvePlanPatch(context, store, patchId);
          sendJson(response, result.statusCode, result.body);
          return;
        }
        if (action === 'reject_patch') {
          const patchId = readRequiredPatchId(body, response);
          if (!patchId) return;
          const reason = String(body.reason ?? 'rejected_by_user');
          validateContractInDev('controlMessage', { ...body, action, patchId, reason });
          const result = rejectPlanPatch(context, store, patchId, reason);
          sendJson(response, result.statusCode, result.body);
          return;
        }
        if (action === 'enqueue') {
          const input = String(body.input ?? body.prompt ?? body.request ?? '').trim();
          if (!input) {
            sendJson(response, 400, { error: 'Missing input.' });
            return;
          }
          validateContractInDev('controlMessage', { ...body, action, input });
          const item = enqueueControlRequest(context, input);
          void startNextControlRequest(context);
          sendJson(response, 202, {
            accepted: true,
            item,
            ...controlStatus(context, store),
          });
          return;
        }
        if (action === 'cancel_item') {
          const itemId = String(body.itemId ?? body.id ?? '').trim();
          if (!itemId) {
            sendJson(response, 400, { error: 'Missing itemId.' });
            return;
          }
          validateContractInDev('controlMessage', { ...body, action, id: itemId });
          const result = cancelQueuedControlItem(context.session, itemId, {
            cancelItem: (item, reason) => emitControlCancelled(context, item, reason),
            skipItem: (item, reason) => emitControlSkipped(context, item, reason),
          });
          void drainControlQueue(context);
          sendJson(response, result.cancelled ? 202 : 200, { ...result, ...controlStatus(context, store) });
          return;
        }
        sendJson(response, 400, { error: 'Unsupported control action.' });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/config/profiles') {
        if (typeof configProfiles !== 'function') {
          sendJson(response, 501, { error: 'Config profiles are not supported.' });
          return;
        }
        const workspace = workspaceFromUrl(url);
        const context = await resolveContext({ workspace });
        const result = await configProfiles(context);
        sendJson(response, 200, result);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/config/use') {
        if (typeof useConfigProfile !== 'function') {
          sendJson(response, 501, { error: 'Config profile switching is not supported.' });
          return;
        }
        const { body, context } = await resolveBodyContext(request, url);
        if (context.running) {
          sendJson(response, 409, { error: 'Cannot switch config while a runtime run is active.' });
          return;
        }
        const profile = String(body.profile ?? '').trim();
        if (!profile) {
          sendJson(response, 400, { error: 'Missing profile.' });
          return;
        }
        const result = await useConfigProfile(context, profile);
        sendJson(response, 200, result);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/mcp/endpoints') {
        const workspace = workspaceFromUrl(url);
        const context = await resolveContext({ workspace });
        const result = await listMcpEndpoints?.(context);
        sendJson(response, 200, result ?? { endpoints: [] });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/mcp/endpoints') {
        const activeRuns = typeof listActiveRuns === 'function' ? listActiveRuns() : [];
        if (activeRuns.length > 0) {
          sendJson(response, 409, { error: 'MCP connectors cannot be changed while a plan is running.' });
          return;
        }
        const { body, context } = await resolveBodyContext(request, url);
        const action = String(body.action ?? 'upsert').trim().toLowerCase();
        const result = action === 'delete'
          ? await deleteMcpEndpoint?.(context, body)
          : await upsertMcpEndpoint?.(context, body);
        if (!result) {
          sendJson(response, 501, { error: 'MCP endpoint management is not supported.' });
          return;
        }
        sendJson(response, 200, result);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/events/stream') {
        const workspace = workspaceFromUrl(url);
        const context = workspace ? await resolveContext({ workspace }) : null;
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        response.write(`event: state\ndata: ${JSON.stringify(runtimeState(context, store, { workspace, session }))}\n\n`);
        const client = { response, workspace };
        clients.add(client);
        request.on('close', () => clients.delete(client));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/run') {
        const { body, context } = await resolveBodyContext(request, url);
        try {
          const input = String(body.input ?? body.prompt ?? '').trim();
          if (!input) {
            sendJson(response, 400, { error: 'Missing input.' });
            return;
          }
          validateContractInDev('runRequest', { ...body, input });
          const explicitSkillName = String(body.skillName ?? '').trim().toLowerCase();
          const invokedSkillName = /^\/([A-Za-z0-9_-]+)/.exec(input)?.[1]?.toLowerCase() ?? '';
          if (body.skillArguments !== undefined && explicitSkillName !== invokedSkillName) {
            sendJson(response, 400, { ok: false, terminal: true, code: 'skill_name_mismatch' });
            return;
          }
          // This structured API call is itself the caller's explicit skill
          // designation, including for reserved names. The equality check
          // above prevents `skillName: status` from turning unrelated prose
          // into the homonymous skill. Model-originated calls additionally
          // pass explicitSkillReference() before reaching this endpoint.
          if (explicitSkillName && body.skillArguments !== undefined) {
            const result = await context.session._runSkillWithinRun(explicitSkillName, body.skillArguments, {
              idempotencyKey: body.idempotencyKey ?? null,
              turnId: body.turnId ?? null,
              selectionKind: body.selectionKind ?? null,
              // Pile de l'appelant : c'est le seul canal par lequel elle peut
              // franchir la frontière HTTP.
              skillStack: Array.isArray(body.skillStack) ? body.skillStack : [],
            });
            sendJson(response, result.accepted ? 202 : skillResultErrorStatus(result), result);
            return;
          }
          const skillMatch = matchSkillInvocation(context.session, input, {
            // Reserved names are unlocked only by a matching structured skill
            // invocation, never by an unrelated truthy marker in the body.
            allowReserved: Boolean(explicitSkillName && explicitSkillName === invokedSkillName),
          });
          if (skillMatch) {
            try {
              const result = await enqueueSkillInvocation(context, skillMatch);
              const explanation = await generateSkillAcknowledgment(context.session, result);
              sendJson(response, 202, { accepted: true, kind: 'skill_chain', explanation, ...result, ...controlStatus(context, store) });
            } catch (err) {
              const error = skillInvocationErrorMessage(err);
              publishSkillInvocationFailure(context, input, error);
              sendJson(response, skillInvocationErrorStatus(err), { error, code: err?.code ?? 'skill_compile_failed' });
            }
            return;
          }
          if (context.running) {
            // A structured capability plan must never degrade into a free-text
            // control message: its exact arguments and approval policy would
            // otherwise be discarded by the control lane. It can still be
            // queued as a future run when the caller explicitly opts in via
            // intent: 'enqueue' — the control queue carries capabilityPlan
            // through untouched (see enqueueControlRequest/
            // startNextControlRequest) instead of collapsing it to text.
            if (body.capabilityPlan) {
              if (body.intent === 'enqueue') {
                const item = enqueueControlRequest(context, input, { capabilityPlan: body.capabilityPlan });
                void startNextControlRequest(context);
                sendJson(response, 202, {
                  accepted: true,
                  item,
                  ...controlStatus(context, store),
                });
                return;
              }
              sendJson(response, 409, { error: 'run_active' });
              return;
            }
            // Blind enqueueing made every message typed during a run
            // invisible until the run ended (serve UI symptom: "no result
            // until the job finished or was stopped"). Classify instead:
            // observe → immediate status explanation, cancel → abort,
            // ambiguous action → explicit choices, explicit "later" intent
            // (body.intent = 'enqueue') → enqueue as before.
            const result = await handleControlMessage(context, store, input, {
              intent: body.intent,
              startNextControlRequest,
              cancel,
              approve,
            });
            sendJson(response, result.statusCode, result.body);
            return;
          }
          const accepted = startRuntimeRun(context, body);
          sendJson(response, 202, accepted);
        } catch (err) {
          context.running = false;
          context.currentAbortController = null;
          throw err;
        }
        return;
      }
      if (request.method === 'POST' && url.pathname === '/turn') {
        const { body, context } = await resolveBodyContext(request, url);
        let input = String(body.input ?? body.prompt ?? '').trim();
        if (!input) {
          sendJson(response, 400, { error: 'Missing input.' });
          return;
        }
        // What the reader actually typed. `input` below may be replaced by a
        // system fact block for the model; the THREAD must still show the
        // reader's own words — the replacement was persisted as the
        // `user_message` and replayed as history on every later turn, which is
        // exactly the "raw facts never enter the thread" rule it broke.
        const displayInput = input;
        // Read-only chat turns intentionally remain available while an agent
        // run is active. Other interactive turns still become control
        // messages so they cannot start a competing agent decision.
        let readOnlyChat = String(body.mode ?? '').toLowerCase() === 'chat';
        // An explicit /skill invocation has deterministic meaning. Keep the
        // conversational /turn boundary, but do not ask the LLM to rediscover
        // the skill from prose: it could choose a direct mutation instead and
        // silently bypass the private workflow. Informational prose merely
        // mentioning a skill never matches this anchored invocation parser.
        const skillMatch = !readOnlyChat ? matchSkillInvocation(context.session, input) : null;
        if (skillMatch) {
          try {
            const result = await enqueueSkillInvocation(context, skillMatch);
            const explanation = await generateSkillAcknowledgment(context.session, result);
            sendJson(response, 202, { accepted: true, kind: 'skill_chain', explanation, ...result, ...controlStatus(context, store) });
          } catch (err) {
            const error = skillInvocationErrorMessage(err);
            publishSkillInvocationFailure(context, input, error);
            sendJson(response, skillInvocationErrorStatus(err), { error, code: err?.code ?? 'skill_compile_failed' });
          }
          return;
        }
        // A run/job status question must NEVER surface the raw system text in
        // the thread: the runtime collects the facts and hands them to Donna,
        // who synthesizes them in the session language. `readOnlyChat` so the
        // turn is a conversation, not a control decision — and the facts are
        // supplied here so the model cannot mistake the runtime run id for a
        // production job id ("job not found").
        if (asksForRunStatus(input)) {
          input = runtimeStatusSynthesisPrompt(input, controlStatus(context, store));
          readOnlyChat = true;
        }
        if (context.running && !readOnlyChat) {
          // Agent-mode message while a run is active. Classify once: control
          // verbs and new tasks go to the control lane, plain conversation is
          // ANSWERED read-only (like a chat turn) instead of parking the
          // reader in a choice menu — the chat must stay usable during runs.
          const classification = await classifyControlMessage(input, controlStatus(context, store), {
            llm: context?.session?.llm,
            session: context?.session,
          });
          if (classification.kind === 'observe') {
            // An observation is system facts, not a control action: Donna gets
            // them and answers in the session language, never a raw English
            // line pushed into the thread.
            input = runtimeStatusSynthesisPrompt(input, controlStatus(context, store));
            readOnlyChat = true;
          } else if (classification.kind !== 'converse') {
            const result = await handleControlMessage(context, store, input, {
              intent: body.intent,
              startNextControlRequest,
              cancel,
              approve,
            });
            sendJson(response, result.statusCode, result.body);
            return;
          } else {
            readOnlyChat = true;
          }
        }
        if (typeof turn !== 'function') {
          sendJson(response, 501, { error: 'Runtime interactive turns are unavailable.' });
          return;
        }
        const turnId = `turn-${randomUUID()}`;
        const controller = new AbortController();
        const previous = context.interactiveTurn ?? Promise.resolve();
        const current = previous.catch(() => {}).then(async () => {
          // A preceding serialized turn may have delegated and started a run
          // after this request was accepted. Reclassify against the fresh
          // state instead of starting another interactive decision in parallel.
          if (context.running && !readOnlyChat) {
            const classification = await classifyControlMessage(input, controlStatus(context, store), {
              llm: context?.session?.llm,
              session: context?.session,
            });
            if (classification.kind === 'observe') {
              input = runtimeStatusSynthesisPrompt(input, controlStatus(context, store));
              readOnlyChat = true;
            } else if (classification.kind !== 'converse') {
              const result = await handleControlMessage(context, store, input, {
                intent: body.intent,
                startNextControlRequest,
                cancel,
                approve,
              });
              publish(createAgentEvent('assistant_message', {
                origin: 'runtime_turn',
                turnId,
                workspace: context.workspace ?? null,
                payload: { content: result.body?.explanation ?? 'Runtime control request processed.' },
              }));
              return result.body;
            }
          }
          return turn(context, {
            ...body,
            input,
            displayInput,
            mode: readOnlyChat ? 'chat' : body.mode,
          }, {
            signal: controller.signal,
            turnId,
          });
        });
        context.interactiveTurn = current;
        void current.catch((err) => {
          publish(createAgentEvent('assistant_message', {
            origin: 'runtime_turn',
            turnId,
            workspace: context.workspace ?? null,
            payload: { content: `Runtime turn failed: ${err instanceof Error ? err.message : String(err)}` },
          }));
        }).finally(() => {
          if (context.interactiveTurn === current) context.interactiveTurn = null;
        });
        sendJson(response, 202, {
          accepted: true,
          kind: 'turn',
          turnId,
          workspace: context.workspace ?? null,
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/delegate') {
        const { body, context } = await resolveBodyContext(request, url);
        const objective = String(body.objective ?? '').trim();
        if (!objective) {
          sendJson(response, 400, { error: 'Missing objective.' });
          return;
        }
        if (context.running) {
          sendJson(response, 409, { error: 'A runtime run is already active.' });
          return;
        }
        if (typeof delegate !== 'function') {
          sendJson(response, 501, { error: 'Runtime delegation is unavailable.' });
          return;
        }
        try {
          const prepared = await delegate(context, { objective, workspace: body.workspace ?? context.workspace ?? null });
          const started = startRuntimeRun(context, {
            input: objective,
            workspace: body.workspace ?? context.workspace ?? null,
            preparedDelegation: prepared,
            evaluate: false,
          }, { waitForPlan: true });
          await started.ready;
          sendJson(response, 202, { accepted: true, runId: started.runId, workspace: started.workspace, delegation: prepared.summary ?? null });
        } catch (err) {
          sendJson(response, 422, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }
      if (request.method === 'POST' && url.pathname === '/cancel') {
        const workspace = workspaceFromUrl(url);
        const context = await resolveContext({ workspace });
        if (!context.running || !context.currentAbortController) {
          sendJson(response, 200, { cancelled: false, reason: 'no active run' });
          return;
        }
        cancelControlChain(context.session, {
          runId: context.currentRunId,
          cancelItem: (item, reason) => emitControlSkipped(context, item, reason),
        });
        context.currentAbortController.abort();
        await cancel?.(context);
        sendJson(response, 202, { cancelled: true, workspace: context.workspace ?? workspace ?? null });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/kill') {
        const body = await readJson(request);
        const workspace = workspaceFromBody(body) ?? workspaceFromUrl(url);
        const runId = url.searchParams.get('runId') ?? body.runId ?? null;
        const purge = body.purge === true || url.searchParams.get('purge') === 'true';
        const context = await resolveContext({ workspace });
        const resolvedWorkspace = context?.workspace ?? workspace ?? null;
        if (purge && !runId && !resolvedWorkspace) {
          // Purge is workspace-wide and destructive: without a scope it would
          // wipe every workspace's history. Mirror /conversation/truncate.
          sendJson(response, 400, { killed: false, reason: 'workspace_required' });
          return;
        }
        const result = await killRuntimeRuns(context, { workspace, runId, purge });
        publishState(context.workspace ?? workspace ?? null, context);
        sendJson(response, 202, result);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/shutdown') {
        const workspace = workspaceFromUrl(url);
        const context = await resolveContext({ workspace });
        if (context?.running && context.currentAbortController) {
          // Reason-tagged: the poll loop still has to unwind so its `finally`
          // releases locks before the process exits, but this is the manager
          // going away, not a user cancellation — the dispatcher must not
          // read it as "give up on the agent job too". recoveryManager.js's
          // idempotency requeue exists precisely to reattach to that job on
          // the next boot; cancelling it here defeats that on every restart.
          context.currentAbortController.abort(RUNTIME_SHUTDOWN_ABORT_REASON);
          await cancel?.(context);
        }
        sendJson(response, 202, { shutdown: true });
        setImmediate(() => {
          for (const client of clients) client.response.end();
          clients.clear();
          server.close(() => {
            if (exitOnShutdown) process.exit(0);
          });
        });
        return;
      }
      // Redo: drop the conversation entry at `index` (the question) AND
      // everything recorded after it. The conversation is derived from the
      // event log, so a UI-side deletion alone would be undone by the next
      // /state merge — the truncation has to happen here.
      //
      // The question goes too because every caller of this route immediately
      // resubmits it. Keeping it server-side meant the resubmission appended a
      // second copy, and the next /state merge brought the first one back into
      // a UI that had just removed it — the question ended up displayed twice
      // in both the served chat and the shell.
      if (request.method === 'POST' && url.pathname === '/conversation/truncate') {
        const { body, workspace, context } = await resolveBodyContext(request, url);
        if (context?.running) {
          // Truncating under a live run would delete events it is still
          // appending to. The caller cancels first.
          sendJson(response, 409, { truncated: false, reason: 'run_active' });
          return;
        }
        const resolvedWorkspace = context?.workspace ?? workspace ?? null;
        if (!resolvedWorkspace) {
          // Unscoped, redo would truncate every workspace's event history —
          // never allow the global/no-workspace conversation to reach it.
          sendJson(response, 400, { truncated: false, reason: 'workspace_required' });
          return;
        }
        const index = Number(body.index);
        if (!Number.isInteger(index) || index < 0) {
          sendJson(response, 400, { truncated: false, reason: 'invalid_index' });
          return;
        }
        const events = store.listEvents({ workspace: resolvedWorkspace });
        const sequences = conversationEventSequences(events);
        const boundary = sequences[index];
        if (!Number.isFinite(boundary)) {
          sendJson(response, 400, { truncated: false, reason: 'index_out_of_range' });
          return;
        }
        // `boundary` is the sequence of the question's own event; deleting
        // strictly after `boundary - 1` removes it along with its answers.
        // Sequences are integers and strictly increasing, so this cannot catch
        // an unrelated event between the two values.
        const removedEvents = store.deleteEventsAfter(boundary - 1, { workspace: resolvedWorkspace });
        // getState prefers the in-memory projection over the event log, so the
        // deleted answers would survive in RAM without this rehydration.
        if (context?.session) {
          resetSessionProjection(context.session);
          store.hydrateSession(context.session, { workspace: resolvedWorkspace });
        }
        publishState(resolvedWorkspace, context);
        sendJson(response, 200, { truncated: true, index, removedEvents });
        return;
      }
      // Compact: a deliberate "forget everything said so far in this
      // workspace" action (served chat's memory gauge). Unlike
      // /conversation/truncate above, nothing is deleted from the event log —
      // the audit trail (GET /audit) stays intact. A single conversation_reset
      // event is enough: the reducer (core/agentEvents.js) moves the
      // conversationSeedStart boundary on it, and since executeInteractiveTurn
      // rebuilds its conversationSeed from a fresh reduceAgentEvents() replay
      // on every turn, future turns stop seeing anything before this point
      // while the displayed conversation (and the ShellUI thread) stays whole.
      if (request.method === 'POST' && url.pathname === '/conversation/compact') {
        const { workspace, context } = await resolveBodyContext(request, url);
        if (context?.running) {
          sendJson(response, 409, { compacted: false, reason: 'run_active' });
          return;
        }
        const resolvedWorkspace = context?.workspace ?? workspace ?? null;
        if (!resolvedWorkspace) {
          sendJson(response, 400, { compacted: false, reason: 'workspace_required' });
          return;
        }
        let summary = null;
        if (context?.session) {
          const conversation = Array.isArray(context.session.agentProjection?.conversation)
            ? context.session.agentProjection.conversation
            : [];
          const seedStart = Math.max(0, Number(context.session.agentProjection?.conversationSeedStart) || 0);
          const previousSummary = context.session.agentProjection?.conversationSummary ?? null;
          // Summarize BEFORE dispatching: the event's payload carries the
          // result so the reducer only ever has to store a plain string, and
          // a run cannot start concurrently (already refused with 409 above)
          // to move conversation.length out from under this read.
          summary = await summarizeCompactedConversation(context.session, {
            previousSummary,
            segment: conversation.slice(seedStart),
          });
          dispatchAgentEvent(context.session, createAgentEvent('conversation_reset', {
            origin: 'user',
            workspace: resolvedWorkspace,
            payload: summary ? { summary } : {},
          }));
        }
        publishState(resolvedWorkspace, context);
        sendJson(response, 200, { compacted: true, summary });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/resume') {
        const workspace = workspaceFromUrl(url);
        const result = await resume?.({ workspace });
        sendJson(response, 202, result ?? { resumed: false, workspace: workspace ?? null });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/approve') {
        const body = await readJson(request);
        const workspace = workspaceFromBody(body) ?? workspaceFromUrl(url);
        const result = await approve?.({
          workspace,
          workspaceId: workspace,
          runId: url.searchParams.get('runId') ?? body.runId ?? null,
          itemId: url.searchParams.get('itemId') ?? body.itemId ?? null,
          approvalId: url.searchParams.get('approvalId') ?? body.approvalId ?? null,
          scope: url.searchParams.get('scope') ?? body.scope ?? null,
          taskId: url.searchParams.get('taskId') ?? body.taskId ?? null,
          groupId: url.searchParams.get('groupId') ?? body.groupId ?? null,
          planRevision: readOptionalNumber(url.searchParams.get('planRevision') ?? body.planRevision),
          approvalClasses: readOptionalList(body.approvalClasses ?? body.approvalClass ?? url.searchParams.get('approvalClass')),
          caller: body.caller ?? url.searchParams.get('caller') ?? null,
        });
        sendJson(response, result?.approved ? 202 : 404, result ?? { approved: false });
        return;
      }

      sendJson(response, 404, { error: 'Not found' });
    } catch (err) {
      sendJson(response, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Housekeeping for the in-memory login-attempt rate limiter: nothing else
  // ever calls pruneLoginAttempts, so without this the `attempts` Map grows
  // by one entry per distinct source address for the life of the process.
  const loginAttemptPruneTimer = setInterval(() => pruneLoginAttempts(), 10 * 60 * 1000);
  loginAttemptPruneTimer.unref?.();

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const address = server.address();
      resolve({
        host,
        port: typeof address === 'object' && address ? address.port : port,
        publish,
        drainControl: (context) => drainControlQueue(context),
        close: () => new Promise((closeResolve, closeReject) => {
          clearInterval(loginAttemptPruneTimer);
          for (const client of clients) client.response.end();
          clients.clear();
          server.close((err) => (err ? closeReject(err) : closeResolve()));
        }),
      });
    });
  });

  async function resolveContext({ workspace = null } = {}) {
    const context = await resolvedGetContext(workspace);
    if (context?.session) {
      context.session._runSkillWithinRun = async (skillName, args = {}, metadata = {}) => {
        const skill = findSkill(context.session, skillName);
        if (!skill) {
          const available = listSkills(context.session).map((item) => item.name);
          /*
           A skill the model GUESSED is recoverable, not terminal: the observed
           failure was `/diagnose` (leading slash copied from the catalogue) →
           skill_not_found → the terminal path stripped the tools from the
           synthesis turn → the model wrote `runtime__delegate{...}` as plain
           text and the turn did nothing. An explicitly user-named missing skill
           stays terminal: there is nothing to fall back to.
          */
          return {
            ok: false,
            terminal: metadata.selectionKind === 'explicit_name',
            code: 'skill_not_found',
            message: `No skill named "${skillName}". Pass the exact name without a leading slash (${available.join(', ') || 'none'}), or delegate the objective with runtime__delegate.`,
            availableSkills: available,
          };
        }
        try {
          const idempotencyKey = metadata.idempotencyKey
            ? String(metadata.idempotencyKey)
            : metadata.turnId
              ? skillIdempotencyKey(context.workspace ?? context.session.workspace, metadata.turnId, skill.name, args)
              : null;
          context.skillRuns ??= new Map();
          context.pendingSkillRuns ??= new Map();
          const persistedChainId = idempotencyKey && typeof store.findSkillRun === 'function'
            ? store.findSkillRun({ workspace: context.workspace ?? null, idempotencyKey })
            : null;
          const existingChainId = persistedChainId ?? (idempotencyKey ? context.skillRuns.get(idempotencyKey) : null);
          if (existingChainId) return publicSkillRunProjection(context, skill.name, existingChainId, metadata.selectionKind, true);
          if (idempotencyKey && context.pendingSkillRuns.has(idempotencyKey)) {
            const pendingChainId = await context.pendingSkillRuns.get(idempotencyKey);
            return publicSkillRunProjection(context, skill.name, pendingChainId, metadata.selectionKind, true);
          }
          const creation = runSkillChain(context, skill, {
            args,
            enqueueControlRequest,
            drainControlQueue,
            selectionKind: metadata.selectionKind,
            // La pile du run appelant : elle sera empilée sur chaque élément mis
            // en file, et c'est elle seule qui survit au hand-off.
            skillStack: Array.isArray(metadata.skillStack) ? metadata.skillStack : [],
          });
          if (idempotencyKey) context.pendingSkillRuns.set(idempotencyKey, creation.then((item) => item.chainId));
          const result = await creation;
          if (idempotencyKey) {
            context.skillRuns.set(idempotencyKey, result.chainId);
            store.persistSkillRun?.({
              workspace: context.workspace ?? context.session.workspace ?? null,
              idempotencyKey,
              chainId: result.chainId,
            });
          }
          return publicSkillRunProjection(context, skill.name, result.chainId, metadata.selectionKind, false);
        } catch (error) {
          return {
            ok: false,
            terminal: true,
            code: error?.code ?? 'skill_compile_failed',
          };
        } finally {
          const key = metadata.idempotencyKey
            ? String(metadata.idempotencyKey)
            : metadata.turnId
              ? skillIdempotencyKey(context.workspace ?? context.session.workspace, metadata.turnId, skill.name, args)
              : null;
          if (key) context.pendingSkillRuns?.delete(key);
        }
      };
    }
    return context;
  }

  // Shared by POST handlers that take a JSON body carrying an optional
  // `workspace` field: read the body, resolve the target workspace (body
  // wins over the `?workspace=` query param), then resolve its context.
  async function resolveBodyContext(request, url) {
    const body = await readJson(request);
    const workspace = workspaceFromBody(body) ?? workspaceFromUrl(url);
    const context = await resolveContext({ workspace });
    return { body, workspace, context };
  }

  async function killRuntimeRuns(context, { workspace = null, runId = null, purge = false } = {}) {
    const targetWorkspace = context?.workspace ?? workspace ?? null;
    const targetRunId = runId ? String(runId) : null;
    if (!targetRunId || targetRunId === context?.currentRunId) {
      context?.currentAbortController?.abort();
      await cancel?.(context);
    }
    const runs = typeof store.interruptRuns === 'function'
      ? store.interruptRuns({ workspace: targetWorkspace, runId: targetRunId, reason: 'Runtime run killed by user.' })
      : 0;
    const tasks = typeof store.cancelActiveTasksForInterruptedRuns === 'function'
      ? store.cancelActiveTasksForInterruptedRuns({ workspace: targetWorkspace, runId: targetRunId })
      : 0;
    const queued = cancelQueuedControlItems(context?.session, targetWorkspace);
    // Purge (/clear --all): interrupting recoverable runs does not clear a
    // terminal 'error' run still projected in memory, nor the persisted event
    // log. Empty both so PLAN/ACTIVITY/LOGS disappear and stay gone after a
    // reboot. runId-scoped kills never purge (too coarse — it is workspace-wide).
    let purged = null;
    if (purge && !targetRunId) {
      resetSessionProjection(context?.session);
      purged = typeof store.clearWorkspaceState === 'function'
        ? store.clearWorkspaceState({ workspace: targetWorkspace })
        : { runs: 0, events: 0, queue: 0 };
    }
    return { killed: true, workspace: targetWorkspace, runId: targetRunId, runs, tasks, queued, ...(purged !== null ? { purged } : {}) };
  }

  function startRuntimeRun(context, body, { controlItemId = null, waitForPlan = false, announceLaunch = false } = {}) {
    const runId = randomUUID();
    const runWorkspace = context.workspace ?? body.workspace ?? null;
    context.running = true;
    context.currentAbortController = new AbortController();
    context.currentRunId = runId;
    context.currentRunWorkspace = runWorkspace;
    let resolveReady;
    let rejectReady;
    const ready = waitForPlan ? new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }) : null;
    const runBody = {
      ...body,
      workspace: runWorkspace,
      runId,
      ...(waitForPlan ? { _planReady: { resolve: resolveReady, reject: rejectReady } } : {}),
    };
    if (controlItemId) {
      dispatchAgentEvent(context.session, createAgentEvent('control_started', {
        origin: 'runtime',
        runId,
        workspace: runWorkspace,
        payload: { id: controlItemId, runId },
      }));
      // A control item is now a live run: announce it in the conversation so the
      // "queued" acknowledgement is closed out by a "starting" one. A task is a
      // task whether it waited or not — it is about to go through approval — so
      // this is not gated on having waited. Skill-chain steps are skipped: they
      // already announced the whole skill at invocation.
      if (announceLaunch) {
        announceControlLaunch(context.session, body.publicInput ?? body.input, runWorkspace);
      }
    }
    // The trigger hook and the proactive marker belong to THIS run on the
    // session; the review that opened it is remembered so its concurrency slot
    // is released exactly once, whatever terminal state it reaches.
    if (context.session) context.session._onKnowledgeTrigger = (payload) => handleKnowledgeTrigger(context, payload);
    if (body.proactiveReview) {
      if (context.session) context.session._proactiveReview = { ...body.proactiveReview, runId };
      proactiveRuns.set(runId, body.proactiveReview);
    }
    const runPromise = run(context, runBody, { signal: context.currentAbortController.signal, runId });
    runPromise
      .catch((err) => {
        rejectReady?.(err);
        // The runId travels with the failure: without it `finishControlByRun`
        // had nothing to match, so a queued restore stayed "pending" forever
        // while the run that carried it was already dead.
        context.session?._onRuntimeError?.(err, runId);
      })
      .finally(() => {
        const proactive = proactiveRuns.get(runId);
        if (proactive) {
          proactiveRuns.delete(runId);
          proactiveScheduler.release(proactive.workspace);
        }
        if (context.session?._proactiveReview?.runId === runId) context.session._proactiveReview = null;
        context.running = false;
        context.currentAbortController = null;
        context.currentRunId = null;
        context.currentRunWorkspace = null;
        publishState(runWorkspace, context);
        void drainControlQueue(context);
      });
    return { accepted: true, runId, workspace: runWorkspace, ...(ready ? { ready } : {}) };
  }

  function startNextControlRequest(context) {
    return drainControlQueue(context);
  }

  function drainControlQueue(context) {
    return reconcileControlQueue(context, {
      /*
       La provenance de chaîne suit le run.

       `chainId` et `skillName` vivaient sur l'item de contrôle et s'arrêtaient
       là : le run ne savait pas qu'il exécutait une intention compilée depuis
       une compétence. L'agent voyait donc un objectif métier — « ingérer les
       fichiers en attente » — qui ressemble par construction à la description
       de la compétence dont il sort, et la resélectionnait. En headless, où
       personne n'interrompt, cela boucle jusqu'à épuisement du budget LLM.
      */
      startItem: (item) => startRuntimeRun(context, {
        input: takePrivateControlInput(context.session, item),
        publicInput: item.input,
        workspace: item.workspace ?? context.workspace ?? null,
        // Interactive skill runs never approve their own mutations. Headless
        // may still grant the pending run explicitly through --auto-approve.
        ...(item.chainId ? { requireApproval: true } : {}),
        ...(item.capabilityPlan !== undefined ? { capabilityPlan: item.capabilityPlan } : {}),
        ...(item.proactiveReview ? { proactiveReview: item.proactiveReview } : {}),
        ...(item.chainId
          ? {
            skillChain: {
              chainId: item.chainId,
              skillName: item.skillName ?? null,
              execution: item.skillExecution === 'direct' ? 'direct' : 'orchestrated',
              // La pile des ancêtres, sans quoi le run ne peut pas savoir qu'il
              // referme un cycle commencé deux hand-offs plus tôt.
              skillStack: Array.isArray(item.skillStack) ? item.skillStack : [],
            },
          }
          : {}),
      }, { controlItemId: item.id, announceLaunch: !item.chainId }),
      skipItem: (item, reason) => {
        privateControlInputsFor(context.session).delete(item.id);
        emitControlSkipped(context, item, reason);
      },
    });
  }

  /*
   A knowledge fact is not an order: it is an opportunity, and the workspace
   says (opt-in) whether it wants one. The decision is deterministic — dedup,
   cooldown, budget, concurrency — and a refusal is said out loud, never a
   silent no. An accepted trigger queues a read-only `agent.review` through the
   normal control lane; nothing here mutates, creates a worktree or sends
   anything.
  */
  function handleKnowledgeTrigger(context, payload) {
    const session = context?.session ?? null;
    const workspace = String(payload?.workspace ?? context?.workspace ?? '');
    const trigger = String(payload?.trigger ?? '');
    const config = session?.wikircConfig?.proactiveReviews ?? null;
    const decision = proactiveScheduler.decide({
      workspace,
      trigger,
      sourceVersion: payload?.sourceVersion ?? null,
      config,
    });
    if (decision.action !== 'review') {
      emitRuntimeLog(
        session,
        `proactive-review: skipped (${decision.reason}) for ${workspace || 'workspace'} [${trigger}]`,
      );
      return;
    }
    const record = {
      id: `review-${randomUUID()}`,
      workspace,
      trigger,
      sourceVersion: decision.sourceVersion,
      createdAt: new Date().toISOString(),
      budget: proactiveScheduler.snapshot(workspace),
    };
    const objective = buildProactiveReviewObjective({ trigger, sourceVersion: decision.sourceVersion });
    let item;
    try {
      item = enqueueControlRequest(context, objective, {
        publicInput: objective,
        proactiveReview: record,
      });
    } catch (error) {
      // A reservation that never became a queued item must be UNDONE: burning a
      // budget unit and marking the version seen would silently cancel an audit
      // that was never enqueued.
      proactiveScheduler.release(workspace, { undo: true, sourceVersion: decision.sourceVersion });
      emitRuntimeLog(
        session,
        `proactive-review: could not queue the review — ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    emitRuntimeLog(
      session,
      `proactive-review: queued ${item.id} (${trigger}) for ${workspace || 'workspace'} — ${PROACTIVE_REVIEW_CAPABILITY}, read-only`,
    );
    void startNextControlRequest(context);
  }

  function takePrivateControlInput(session, item) {
    const privateControlInputs = privateControlInputsFor(session);
    const input = privateControlInputs.get(item.id) ?? item.input;
    privateControlInputs.delete(item.id);
    return input;
  }

  async function enqueueSkillInvocation(context, match) {
    const result = await runSkillChain(context, match.skill, {
      rawArgs: match.rawArgs,
      enqueueControlRequest,
      drainControlQueue,
      selectionKind: 'explicit_name',
    });
    // Publish only after compilation succeeds. The marker prevents an
    // invocation queued during another run from inheriting that run's id.
    dispatchAgentEvent(context.session, createAgentEvent('user_message', {
      origin: 'user',
      workspace: context.workspace ?? null,
      payload: { content: `/${match.skill.name}${match.rawArgs ? ` ${match.rawArgs}` : ''}`, independent: true },
    }));
    return result;
  }

  function publishSkillInvocationFailure(context, input, error) {
    const workspace = context.workspace ?? context.session?.workspace ?? null;
    dispatchAgentEvent(context.session, createAgentEvent('user_message', {
      origin: 'user', workspace, payload: { content: input, independent: true },
    }));
    dispatchAgentEvent(context.session, createAgentEvent('assistant_message', {
      origin: 'runtime', workspace, payload: { content: error, independent: true },
    }));
  }
}

function skillInvocationErrorStatus(error) {
  return ['skill_compile_failed', 'skill_arguments_invalid'].includes(error?.code) ? 400 : 422;
}

function skillResultErrorStatus(result) {
  if (result?.code === 'skill_not_found') return 404;
  if (result?.code === 'skill_arguments_invalid') return 400;
  return 422;
}

function skillInvocationErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return `Skill invocation could not be compiled: ${message}`;
}

function workspaceFromUrl(url) {
  const workspace = url.searchParams.get('workspace');
  return workspace ? workspace.trim() || null : null;
}

function workspaceFromBody(body) {
  const workspace = body?.workspace;
  return workspace == null ? null : String(workspace).trim() || null;
}

function readTaskEndpoint(url) {
  const parts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  if (parts.length === 3 && parts[0] === 'runs' && parts[2] === 'tasks') {
    return { kind: 'run_tasks', runId: parts[1] };
  }
  if (parts.length === 3 && parts[0] === 'tasks' && parts[2] === 'attempts') {
    return { kind: 'task_attempts', taskId: parts[1] };
  }
  if (parts.length === 3 && parts[0] === 'tasks' && parts[2] === 'result') {
    return { kind: 'task_result', taskId: parts[1] };
  }
  return null;
}

function controlStatus(context, store) {
  const workspace = context?.workspace ?? context?.session?.workspace ?? null;
  const state = runtimeState(context, store, { workspace });
  return {
    ok: true,
    ...state,
    workspace: state.workspace ?? workspace,
    running: Boolean(context?.running),
    controlQueue: controlQueueFor(context?.session),
  };
}

export function runtimeState(context, store, { workspace = null, session = null } = {}) {
  const state = store.getState(context?.session ?? session ?? null, { workspace });
  return {
    ...state,
    // Interactive (runtime_turn) replies are persisted as events but never
    // merged into the canonical in-memory projection, so a state built from
    // that projection omits them — chat mode and conversational agent turns
    // then show no reply at all. Rebuild the conversation from the full
    // persisted event log (the same source interactive turns use to seed their
    // own history) so those replies surface. The log is a superset of the
    // canonical run conversation, so run rendering is unaffected.
    conversation: reduceAgentEvents(store.listEvents({ workspace })).conversation,
    // `context.running` keeps the process alive while the scheduler waits for an
    // approval, but the run is then NOT running — the reducer already says
    // `pending_approval`. Prefer it over the blanket override.
    status: context?.running
      ? (state.status === 'pending_approval' ? 'pending_approval' : 'running')
      : state.status ?? 'idle',
    running: Boolean(context?.running),
    runId: context?.currentRunId ?? state.runId ?? null,
    workspace: context?.currentRunWorkspace ?? context?.workspace ?? state.workspace ?? workspace ?? null,
  };
}

// The live figures of the activity the run is on, in one line: percent, plan
// step, build batch, instruction count and the stabilize counters. A status
// that only named the current step could not tell 5% from 95%, nor what the
// running batch had actually done.
function describeActivityProgress(activity) {
  const progress = activity?.progress ?? {};
  const bits = [];
  if (Number.isFinite(Number(progress.percent))) bits.push(`${Number(progress.percent)}%`);
  if (progress.stepIndex != null && progress.stepTotal != null) bits.push(`step ${progress.stepIndex}/${progress.stepTotal}`);
  if (progress.batchIndex != null && progress.batchCount != null) bits.push(`batch ${Number(progress.batchIndex) + 1}/${progress.batchCount}`);
  if (progress.instructionCount != null) bits.push(`${progress.instructionCount} instruction${Number(progress.instructionCount) > 1 ? 's' : ''}`);
  const stabilize = [progress.stabilizeKept, progress.stabilizeMerged, progress.stabilizeInserted, progress.stabilizeRemoved];
  if (stabilize.some((value) => value != null)) {
    bits.push(`kept ${progress.stabilizeKept ?? 0}, merged ${progress.stabilizeMerged ?? 0}, inserted ${progress.stabilizeInserted ?? 0}, removed ${progress.stabilizeRemoved ?? 0}`);
  }
  const detail = progress.detail && !bits.includes(String(progress.detail)) ? String(progress.detail) : null;
  return { bits: bits.join(' · '), detail, label: activity?.label ?? null };
}

// The facts a status answer is built from, rendered server-side ONCE. A status
// question is answered by Donna, never by pushing this text into the thread:
// the runtime supplies the figures, she phrases them in the session language.
function runtimeStatusFacts(status) {
  const plan = Array.isArray(status.plan) ? status.plan : [];
  const approvals = Array.isArray(status.approvals) ? status.approvals : [];
  const queue = Array.isArray(status.controlQueue) ? status.controlQueue : [];
  const activities = Array.isArray(status.activities)
    ? status.activities
    : Object.values(status.activities ?? {});
  const lines = [
    `Runtime status: ${status.status ?? 'idle'}`,
    `Workspace: ${status.workspace ?? '-'}`,
  ];
  if (status.runId) lines.push(`Run id: ${status.runId}`);
  for (const activity of activities.filter((entry) => !entry?.terminal).slice(0, 8)) {
    const info = describeActivityProgress(activity);
    const detail = [info.bits, info.detail].filter(Boolean).join(' · ');
    lines.push(
      `Activity: ${info.label ?? activity.label ?? activity.id ?? '-'} — ${activity.status ?? '-'}${detail ? ` (${detail})` : ''}`,
    );
  }
  for (const [index, step] of plan.slice(0, 60).entries()) {
    lines.push(`Task ${step.step ?? index + 1}: ${step.status ?? 'pending'} - ${step.description ?? step.label ?? step.id ?? 'step'}`);
  }
  for (const approval of approvals.filter((entry) => entry.status === 'pending_approval')) {
    lines.push(`Pending approval: ${approval.reason ?? approval.taskId ?? approval.id ?? '-'}`);
  }
  for (const item of queue.filter((entry) => entry.status === 'queued')) {
    lines.push(`Queued: ${item.label ?? item.input ?? item.id ?? '-'}`);
  }
  return lines.join('\n');
}

function runtimeStatusSynthesisPrompt(asked, status) {
  return [
    'The runtime facts below are the authoritative status the system just collected (this is a runtime run, not a production job — do not look up a job id).',
    `User question: ${asked}`,
    'Answer in the session language with a concise, natural status: name the requested target first, then progress, blockers (pending approvals), queued items and the next step.',
    'Keep every figure (percent, step, batch, instruction and stabilize counts) and every task status accurate; never invent, drop or round away a figure. Do not paste the fact block verbatim; summarize it into prose.',
    '',
    'Runtime facts:',
    runtimeStatusFacts(status),
  ].join('\n');
}

function explainControlState(status) {
  const plan = Array.isArray(status.plan) ? status.plan : [];
  const activities = Array.isArray(status.activities)
    ? status.activities
    : Object.values(status.activities ?? {});
  // A run whose only outstanding work is a human decision is not "running":
  // `status.running` mirrors the process, which stays alive while the scheduler
  // waits. Mirrors the reducer's rule — pending_approval, or a pending approval
  // with no step actually executing.
  const approvals = Array.isArray(status.approvals) ? status.approvals : [];
  const pendingApproval = approvals.find((approval) => approval.status === 'pending_approval');
  const awaitingApproval = pendingApproval
    && (status.status === 'pending_approval' || !plan.some((step) => isActive(step?.status)));
  if (awaitingApproval) {
    return `Runtime is waiting for approval: ${pendingApproval.reason ?? pendingApproval.id}.`;
  }
  if (status.running) {
    const runningStep = plan.find((step) => step.status === 'running');
    const activity = activities.find((entry) => !entry?.terminal) ?? activities[0] ?? null;
    const info = activity ? describeActivityProgress(activity) : { bits: '', detail: null, label: null };
    const detailText = [info.bits, info.detail].filter(Boolean).join(' · ');
    const suffix = detailText ? ` (${detailText})` : '';
    return runningStep
      ? `Runtime run is active. Current step: ${runningStep.description ?? runningStep.label ?? runningStep.step}.${suffix}`
      : `Runtime run is active. No current plan step is available yet.${suffix}`;
  }
  if (pendingApproval) {
    return `Runtime is waiting for approval: ${pendingApproval.reason ?? pendingApproval.id}.`;
  }
  const queued = status.controlQueue.filter((item) => item.status === 'queued');
  if (queued.length > 0) {
    return `${queued.length} control request${queued.length === 1 ? '' : 's'} queued. They are not applied to the active plan automatically.`;
  }
  if (plan.some((step) => step.status === 'pending')) {
    return 'Runtime is idle with pending plan steps visible from the last run.';
  }
  // Idle at the end of a run: say what the last run did, not just "idle" — that
  // is the question the operator actually asks when the thread goes quiet.
  const failed = plan.filter((step) => isFailed(step.status) || isCancelled(step.status)).length;
  const done = plan.filter((step) => isSuccessful(step.status)).length;
  if (plan.length > 0) {
    return failed > 0
      ? `Runtime is idle. Last run: ${done}/${plan.length} task(s) succeeded, ${failed} failed or cancelled.`
      : `Runtime is idle. Last run: ${done}/${plan.length} task(s) succeeded.`;
  }
  return 'Runtime is idle.';
}

function controlQueueFor(session) {
  return Array.isArray(session?.controlQueue) ? session.controlQueue : [];
}

function skillIdempotencyKey(workspace, turnId, skillName, args) {
  const canonicalArguments = JSON.stringify(Object.fromEntries(
    Object.entries(args ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  ));
  return createHash('sha256')
    .update(`${workspace ?? ''}\0${turnId}\0${String(skillName).toLowerCase()}\0${canonicalArguments}`)
    .digest('hex');
}

function publicSkillRunProjection(context, skillName, chainId, selectionKind, deduplicated) {
  const chainItems = controlQueueFor(context?.session).filter((item) => item.chainId === chainId);
  const resolvedSelectionKind = selectionKind ?? chainItems.find((item) => item.selectionKind)?.selectionKind ?? null;
  const items = chainItems
    .sort((left, right) => Number(left.chainSequence ?? 0) - Number(right.chainSequence ?? 0))
    .map((item) => ({
      id: item.id,
      sequence: Number(item.chainSequence ?? 0),
      status: item.status,
      optional: item.optional === true,
    }));
  return {
    accepted: true,
    skill: skillName,
    chainId,
    objectiveCount: items.length,
    items,
    ...(resolvedSelectionKind ? { selectionKind: resolvedSelectionKind } : {}),
    ...(deduplicated ? { deduplicated: true } : {}),
  };
}

function cancelQueuedControlItems(session, workspace = null) {
  const now = new Date().toISOString();
  const counted = new Set();
  let count = 0;
  for (const queue of [controlQueueFor(session), session?.agentProjection?.controlQueue].filter(Array.isArray)) {
    for (const item of queue) {
      if (item.status !== 'queued') continue;
      if (workspace && item.workspace && item.workspace !== workspace) continue;
      item.status = 'cancelled';
      item.finishedAt = now;
      item.updatedAt = now;
      const id = item.id ?? item.runId ?? `${item.input}:${item.createdAt}`;
      privateControlInputsFor(session).delete(item.id);
      if (!counted.has(id)) {
        counted.add(id);
        if (session) {
          dispatchAgentEvent(session, createAgentEvent('control_cancelled', {
            origin: 'runtime',
            workspace: item.workspace ?? workspace ?? null,
            payload: { id, finishedAt: now },
          }));
        }
        count += 1;
      }
    }
  }
  return count;
}

function readOnlyControlResponse(kind, classification, status, explanation, { accepted = true, extra = {} } = {}) {
  return {
    statusCode: 200,
    body: { accepted, kind, classification, ...status, explanation, ...extra },
  };
}

export function approvalRequestFromStatus(status) {
  const runId = status.runId ?? status.runs?.find((run) => run.status === 'running' || run.status === 'pending_approval')?.id ?? null;
  const pending = (status.approvals ?? []).filter((approval) => approval.status === 'pending_approval');
  const waitingTasks = tasksAwaitingApproval({
    runId,
    workspace: status.workspace ?? null,
    planRevision: status.planRevision ?? null,
    tasks: status.plan ?? [],
  }, { approvals: status.approvals ?? [] });
  const classes = [...new Set([
    ...pending.flatMap((approval) => readOptionalList(approval.approvalClasses ?? approval.approvalClass)),
    ...waitingTasks.map((task) => approvalClassForTask(task)),
  ].filter(Boolean))];
  return {
    workspace: status.workspace ?? null,
    workspaceId: status.workspace ?? null,
    runId,
    scope: 'run',
    planRevision: status.planRevision ?? null,
    approvalClasses: classes.length > 0 ? classes : ['default'],
  };
}

async function handleControlMessage(context, store, input, { intent = null, startNextControlRequest = () => false, cancel = null, approve = null } = {}) {
  const status = controlStatus(context, store);
  const classification = await classifyControlMessage(input, status, {
    forcedIntent: intent,
    llm: context?.session?.llm,
    session: context?.session,
  });
  if (classification.kind === 'observe') {
    return readOnlyControlResponse('observe', classification, status, explainControlState(status));
  }
  if (classification.kind === 'cancel') {
    if (context.running && context.currentAbortController) {
      context.currentAbortController.abort();
      await cancel?.(context);
      return readOnlyControlResponse('cancel', classification, controlStatus(context, store), 'Runtime cancellation requested.', { accepted: true });
    }
    return readOnlyControlResponse('cancel', classification, status, 'No active run to cancel.', { accepted: false });
  }
  if (classification.kind === 'approve') {
    const result = await approve?.(approvalRequestFromStatus(status));
    return readOnlyControlResponse('approve', classification, controlStatus(context, store), result?.approved
      ? 'Approval grant recorded for the current run revision.'
      : 'Approval intent recorded; no pending approval was available to grant.', { accepted: result?.approved === true, extra: { approval: result ?? null } });
  }
  if (classification.kind === 'modify_run') {
    const proposal = storeControlProposal(context, input, classification, status);
    return {
      statusCode: 202,
      body: {
        accepted: true,
        kind: 'modify_run',
        classification,
        proposal,
        ...controlStatus(context, store),
        explanation: controlMessage(context?.session, 'plan_patch_proposed'),
      },
    };
  }
  if (classification.kind === 'enqueue_run') {
    const item = enqueueControlRequest(context, input);
    // Unlike `modify_run`, this may synchronously start a queued run (see
    // startNextControlRequest), which can change running/plan/status — a full
    // controlStatus() recompute is required here, not just controlQueue.
    void startNextControlRequest(context);
    const explanation = await generateControlAcknowledgment(context?.session, { kind: 'queued', input });
    return {
      statusCode: 202,
      body: {
        accepted: true,
        kind: 'enqueue_run',
        classification,
        item,
        ...controlStatus(context, store),
        explanation,
      },
    };
  }
  if (classification.kind === 'ambiguous') {
    return readOnlyControlResponse('ambiguous', classification, status, controlMessage(context?.session, 'ambiguous_control'), {
      accepted: false,
      extra: {
        choices: [
          { action: 'message', intent: 'observe', label: 'Ask about this run' },
          { action: 'message', intent: 'modify_run', label: 'Propose a change to this run' },
          { action: 'enqueue', intent: 'enqueue_run', label: 'Queue as a future run' },
        ],
      },
    });
  }
  return readOnlyControlResponse('converse', classification, status, status.running
    ? controlMessage(context?.session, 'converse_while_running')
    : controlMessage(context?.session, 'converse_while_idle'));
}

/*
 Control-lane acknowledgements are Donna's to localize.

 The control lane stays deterministic in its CLASSIFICATION and its actions,
 but the acknowledgement the user reads ("queued, will run after this one" /
 "the queued task is starting") is a conversational reply: it goes through a
 single bounded LLM completion, like the skill-launch acknowledgement, and
 falls back to the deterministic English catalog when no LLM is configured or
 the call fails. The fallback is what keeps the lane deterministic-under-failure.
 */
const CONVERSATION_SUMMARY_TIMEOUT_MS = 20_000;
const CONVERSATION_SUMMARY_MAX_INPUT_CHARS = 8_000;

/*
 A compact does not just cut older turns from conversationSeed — it replaces
 them with a short rolling summary, so a decision made 20 messages ago is not
 gone from Donna's grounding entirely, only condensed. Best-effort: no LLM
 configured, an empty reply, or a call failure all fall back to keeping
 whatever summary already existed (never worse than before this compact),
 the same deterministic-under-failure shape as generateControlAcknowledgment.
 */
async function summarizeCompactedConversation(session, { previousSummary, segment }) {
  const llm = session?.llm;
  const transcript = (Array.isArray(segment) ? segment : [])
    .filter((message) => ['user', 'assistant'].includes(message?.role) && String(message?.content ?? '').trim())
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${String(message.content).trim()}`)
    .join('\n')
    .slice(0, CONVERSATION_SUMMARY_MAX_INPUT_CHARS);
  if (!transcript) return previousSummary || null;
  if (!(llm && typeof llm.complete === 'function')) return previousSummary || null;
  try {
    const reply = await llm.complete({
      system: 'You maintain a compact working memory for Donna, a workspace assistant. You are shown an optional PREVIOUS SUMMARY and a NEW SEGMENT of conversation about to leave the assistant\'s context window. Write ONE updated summary that preserves the facts, decisions, open questions and user preferences that still matter for future turns. Be concise: well under 200 words. Return only the summary text — no preamble, no meta-commentary, no headings.',
      input: [
        previousSummary ? `PREVIOUS SUMMARY:\n${previousSummary}` : null,
        `NEW SEGMENT:\n${transcript}`,
      ].filter(Boolean).join('\n\n'),
      signal: AbortSignal.timeout(CONVERSATION_SUMMARY_TIMEOUT_MS),
    });
    const text = String(reply ?? '').trim();
    if (text) return text;
    emitRuntimeLog(session, 'conversation-compact: LLM returned an empty summary, keeping the previous one');
  } catch (err) {
    emitRuntimeLog(session, `conversation-compact: summary LLM call failed, keeping the previous summary — ${err instanceof Error ? err.message : String(err)}`);
  }
  return previousSummary || null;
}

async function generateControlAcknowledgment(session, { kind, input }) {
  const language = String(session?.language ?? '').trim().toLowerCase() || 'en';
  const llm = session?.llm;
  const fallback = kind === 'queued'
    ? controlMessage(session, 'queued_for_future_run')
    : controlMessage(session, 'control_run_started');
  if (llm && typeof llm.complete === 'function') {
    try {
      const scenario = kind === 'queued'
        ? 'The user requested a new task while a run is active. It was queued and will start automatically after the current run finishes.'
        : 'A task the user queued earlier is now starting.';
      const instruction = kind === 'queued'
        ? 'their request is queued and will run after the current run finishes'
        : 'the queued task is now starting';
      const reply = await llm.complete({
        system: 'You are Donna, the workspace assistant. You acknowledge a runtime queue event in the user\'s language. Be concise: exactly one short sentence.',
        input: `${scenario}\n\nThe task is: ${input}\n\nWrite ONE short sentence in ${language} that tells the user ${instruction}. Return only that sentence, nothing else.`,
        signal: AbortSignal.timeout(8_000),
      });
      const text = String(reply ?? '').trim();
      if (text) return text;
      emitRuntimeLog(session, 'control-acknowledgment: LLM returned an empty reply, using the deterministic fallback');
    } catch (err) {
      // A degradation must announce itself: silently falling through here
      // hides the difference between "no LLM configured" (expected) and "the
      // configured LLM is failing every call" (a real problem) — both would
      // otherwise look identical from the Shell or serve UI.
      emitRuntimeLog(session, `control-acknowledgment: LLM call failed, using the deterministic fallback — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return fallback;
}

function announceControlLaunch(session, input, workspace) {
  void generateControlAcknowledgment(session, { kind: 'started', input })
    .then((content) => {
      dispatchAgentEvent(session, createAgentEvent('assistant_message', {
        origin: 'runtime',
        workspace,
        payload: { content, independent: true },
      }));
    })
    .catch(() => {});
}

/*
 `skillStack` accompagne l'élément, il ne vit pas sur la session.

 La pile des compétences en cours était posée sur la session pour la durée d'UN
 run, et restaurée par son `finally`. Or une compétence imbriquée n'est pas
 exécutée en ligne : elle est MISE EN FILE, et son run démarre après que le
 parent a fini de se nettoyer. La pile qu'elle lisait était donc déjà vide.

 Conséquence : la garde n'attrapait que le cas pour lequel elle avait été
 écrite — une compétence qui se relance dans son propre run — et laissait
 passer A→B→A, qui boucle jusqu'à épuisement du budget en headless.

 Une file est un passage de témoin : ce qui doit survivre au parent voyage avec
 le message, pas dans l'état de celui qui l'a posté.
*/
function enqueueControlRequest(context, input, { publicInput = null, capabilityPlan, chainId, chainSequence, skillName, skillExecution, skillStack, selectionKind, optional = false, continueOnFailure = false, proactiveReview = null } = {}) {
  const now = new Date().toISOString();
  const item = {
    id: `control-${randomUUID()}`,
    workspace: context?.workspace ?? context?.session?.workspace ?? null,
    type: 'run_request',
    input: publicInput ?? input,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    ...(capabilityPlan !== undefined ? { capabilityPlan } : {}),
    ...(chainId ? { chainId } : {}),
    ...(Number.isInteger(chainSequence) ? { chainSequence } : {}),
    ...(skillName ? { skillName } : {}),
    ...(skillExecution ? { skillExecution } : {}),
    ...(Array.isArray(skillStack) && skillStack.length ? { skillStack: [...skillStack] } : {}),
    ...(selectionKind ? { selectionKind } : {}),
    // The proactive marker rides on the ITEM, so it survives projection and a
    // runtime restart, and the drain can hand it back to the run it starts.
    ...(proactiveReview ? { proactiveReview } : {}),
    optional: optional === true,
    continueOnFailure: continueOnFailure === true,
  };
  privateControlInputsFor(context?.session).set(item.id, input);
  dispatchAgentEvent(context.session, createAgentEvent('control_enqueued', {
    origin: 'runtime',
    workspace: item.workspace,
    payload: item,
  }));
  return item;
}

function emitControlSkipped(context, item, reason) {
  dispatchAgentEvent(context.session, createAgentEvent('control_skipped', {
    origin: 'runtime',
    workspace: item.workspace ?? context.workspace ?? null,
    payload: { id: item.id, reason, finishedAt: new Date().toISOString() },
  }));
}

function emitControlCancelled(context, item, reason) {
  privateControlInputsFor(context?.session).delete(item.id);
  dispatchAgentEvent(context.session, createAgentEvent('control_cancelled', {
    origin: 'runtime',
    workspace: item.workspace ?? context.workspace ?? null,
    payload: { id: item.id, reason, finishedAt: new Date().toISOString() },
  }));
}

function storeControlProposal(context, input, classification, status) {
  const now = new Date().toISOString();
  const patch = buildPlanPatchFromInput(input, status);
  const proposal = {
    id: `proposal-${randomUUID()}`,
    workspace: context?.workspace ?? context?.session?.workspace ?? null,
    type: 'active_plan_mutation',
    input,
    status: 'proposed',
    reason: classification.reason,
    patch,
    createdAt: now,
    updatedAt: now,
  };
  dispatchAgentEvent(context.session, createAgentEvent('control_message_received', {
    origin: 'runtime',
    runId: context.currentRunId ?? status.runId ?? null,
    workspace: proposal.workspace,
    payload: { input, intent: 'modify_run', classification },
  }));
  dispatchAgentEvent(context.session, createAgentEvent('plan_patch_proposed', {
    origin: 'runtime',
    runId: context.currentRunId ?? status.runId ?? null,
    workspace: proposal.workspace,
    payload: {
      id: proposal.id,
      input,
      patch,
    },
  }));
  return proposal;
}

function buildPlanPatchFromInput(input, status) {
  const plan = Array.isArray(status.plan) ? status.plan : [];
  const doneIds = plan.filter((step) => step.status === 'done').map((step) => String(step.id ?? step.step));
  const active = plan.find((step) => step.status === 'running')
    ?? plan.find((step) => step.status === 'pending')
    ?? plan.at(-1);
  const dependsOn = active ? [String(active.id ?? active.step)] : doneIds.slice(-1);
  const description = String(input).replace(/\s+/g, ' ').trim();
  return normalizePlanPatch({
    targetRunId: status.runId ?? null,
    basePlanRevision: status.planRevision ?? 0,
    reason: 'control_mutate',
    operations: [{
      op: 'add_task',
      task: {
        id: `task-${randomUUID().slice(0, 8)}`,
        description,
        dependsOn: dependsOn.filter(Boolean),
        executorQuery: { capability: description },
      },
    }],
  });
}

function approvePlanPatch(context, store, patchId) {
  const status = controlStatus(context, store);
  const proposal = status.planPatches.find((patch) => patch.id === patchId);
  if (!proposal) {
    return { statusCode: 404, body: { accepted: false, error: 'Plan patch proposal not found.' } };
  }
  if (proposal.status === 'applied' || proposal.status === 'rejected') {
    // Idempotency guard: re-running applyPlanPatch here would hit
    // duplicate_task_id for an already-applied add_task patch, and the
    // plan_patch_applied reducer would then overwrite status back to
    // 'rejected' even though the original application is still in effect.
    return {
      statusCode: 409,
      body: { accepted: false, error: `Plan patch already ${proposal.status}.`, patchId, status: proposal.status },
    };
  }
  const currentRevision = status.planRevision ?? 0;
  let patch = proposal.patch;
  if (!patch) {
    return { statusCode: 400, body: { accepted: false, error: 'Plan patch proposal has no patch.' } };
  }
  if (patch.basePlanRevision !== currentRevision) {
    patch = rebasePlanPatch(patch, { currentRevision });
    dispatchAgentEvent(context.session, createAgentEvent('plan_patch_rebased', {
      origin: 'runtime',
      runId: context.currentRunId ?? status.runId ?? null,
      workspace: status.workspace ?? context.workspace ?? null,
      payload: { patchId, patch },
    }));
  }
  dispatchAgentEvent(context.session, createAgentEvent('plan_patch_approved', {
    origin: 'runtime',
    runId: context.currentRunId ?? status.runId ?? null,
    workspace: status.workspace ?? context.workspace ?? null,
    payload: { patchId },
  }));
  dispatchAgentEvent(context.session, createAgentEvent('plan_patch_applied', {
    origin: 'runtime',
    runId: context.currentRunId ?? status.runId ?? null,
    workspace: status.workspace ?? context.workspace ?? null,
    payload: { patchId, patch },
  }));
  return {
    statusCode: 202,
    body: {
      accepted: true,
      kind: 'approve_patch',
      patchId,
      ...controlStatus(context, store),
    },
  };
}

function rejectPlanPatch(context, store, patchId, reason) {
  const status = controlStatus(context, store);
  const proposal = status.planPatches.find((patch) => patch.id === patchId);
  if (!proposal) {
    return { statusCode: 404, body: { accepted: false, error: 'Plan patch proposal not found.' } };
  }
  if (proposal.status === 'applied' || proposal.status === 'rejected') {
    return {
      statusCode: 409,
      body: { accepted: false, error: `Plan patch already ${proposal.status}.`, patchId, status: proposal.status },
    };
  }
  dispatchAgentEvent(context.session, createAgentEvent('plan_patch_rejected', {
    origin: 'runtime',
    runId: context.currentRunId ?? status.runId ?? null,
    workspace: status.workspace ?? context.workspace ?? null,
    payload: { patchId, reason },
  }));
  return {
    statusCode: 200,
    body: { accepted: true, kind: 'reject_patch', patchId, ...controlStatus(context, store) },
  };
}

// A question about the run/job currently executing. The free-text form is
// deliberately narrow — a status word AND a run/job noun — so it never hijacks
// an ordinary "explain how X works" question. Such a question must be answered
// by the runtime itself: left to the model, a runtime runId was mistaken for a
// production job id and reported as "not found", and a read-only chat turn had
// no runtime status tool.
//
// The reserved built-in `/status` is ALWAYS a runtime status, in every surface:
// `RESERVED_SLASH_COMMANDS` keeps the homonymous workspace skill out of
// `matchSkillInvocation`, but without this branch `/turn` still handed the
// literal command to the model, which ran the skill (English "status" output) or
// an unrelated review instead of reporting anything. Serve types `/status` into
// this endpoint; the ShellUI answers it locally.
function asksForRunStatus(input) {
  const text = String(input ?? '').trim();
  if (/^\/status(?:\s|$)/i.test(text)) return true;
  const statusWord = /\b(status|statut|progression|progress|avancement|o[uù] en est|o[uù] en sont)\b/i;
  const runNoun = /\b(job|run|t[aâ]che|task|build|ingest|pipeline|export|polish|traitement)\b/i;
  return statusWord.test(text) && runNoun.test(text);
}

// Classifier for the control lane's free-text messages. The classification is
// LLM-backed: the only deterministic matches left are the runtime's own
// control verbs (cancel, an explicit "later/queue", status and plan-change
// wording). Deciding "is this a NEW task to queue vs plain conversation" is a
// semantic judgement about the workspace's domain, so it is never a keyword
// list here — it goes to the model, bounded, and falls back to the choice menu
// (`ambiguous`) rather than guessing when no model is available.
export async function classifyControlMessage(input, status, { forcedIntent = null, llm = null, session = null } = {}) {
  // Caller (the /control message route) already trims and rejects empty input.
  const lower = String(input ?? '').toLowerCase();
  const intent = forcedIntent ? String(forcedIntent).toLowerCase() : null;
  const explicit = {
    observe: 'observe',
    converse: 'converse',
    approve: 'approve',
    modify_run: 'modify_run',
    mutate: 'modify_run',
    enqueue_run: 'enqueue_run',
    enqueue: 'enqueue_run',
    cancel: 'cancel',
    ambiguous: 'ambiguous',
  }[intent];
  if (explicit) {
    return { kind: explicit, confidence: 1, reason: 'explicit_intent' };
  }
  // Cancel stays a keyword: it is a runtime control verb, and an abort must not
  // wait on a model round-trip.
  if (/\b(cancel|annule|stop|arr[eê]te|interromps|abort)\b/i.test(lower)) {
    return { kind: 'cancel', confidence: 0.86, reason: 'cancel_request' };
  }
  if (/\b(plus tard|later|ensuite|apr[eè]s ce run|enqueue|mets en file|met en file|futur|next run|future run)\b/i.test(lower)) {
    return { kind: 'enqueue_run', confidence: 0.8, reason: 'future_run_request' };
  }
  if (/\b(o[uù] en es[t-]|status|statut|progress|progression|logs?|explique|explain|inspect|show|montre|quoi de neuf)\b/i.test(lower)) {
    return { kind: 'observe', confidence: 0.86, reason: 'status_or_explanation_request' };
  }
  // A bare "yes" answers the runtime's own last prompt (the launch
  // acknowledgement used to end on "check progress or cancel?"). While a run is
  // active, the only thing the runtime can act on is a status check: treating
  // the word as ordinary conversation made the read-only chat fallback lecture
  // the user about switching modes instead of answering.
  // Anchored at BOTH ends: "oui" is a confirmation, "oui, ajoute une étape de
  // polish" is a plan change. Without the end anchor this branch shadowed
  // modify_run and enqueue_run for every message merely STARTING on a yes.
  if (status.running && /^\s*(oui|yes|yep|ok|okay|vas[- ]?y|d'accord|daccord|entendu)\s*[.!…]*\s*$/i.test(lower)) {
    return { kind: 'observe', confidence: 0.7, reason: 'confirmation_of_runtime_prompt' };
  }
  if (status.running && /\b(ajoute|add|change|modifie|modify|remplace|replace|retire|remove|skip|ignore|apr[eè]s|before|after|chaque|each|plan|step|t[aâ]che)\b/i.test(lower)) {
    return { kind: 'modify_run', confidence: 0.78, reason: 'active_run_change_request' };
  }
  if (!status.running) return { kind: 'converse', confidence: 0.62, reason: 'plain_conversation' };
  // A run is active and none of the runtime control verbs matched. The message
  // is either a request to perform a NEW mutating task (→ queue it to run
  // after the current one) or ordinary conversation — that is a judgement about
  // the workspace's domain, so the model decides it, never a keyword list.
  if (llm && typeof llm.complete === 'function') {
    try {
      const reply = await llm.complete({
        system: 'You classify one user message typed while a run is already active. Return exactly one word, nothing else.',
        input: [
          `The user typed this while a run is active: "${input}"`,
          '',
          'Choose ONE of:',
          '- "action" — a request to perform a NEW task (generate, create, ingest, build, export, convert, send, publish, produce…), which must run after the current run.',
          '- "conversation" — ordinary conversation, a question, or an unrelated remark.',
          '',
          'Return only that one word.',
        ].join('\n'),
        signal: AbortSignal.timeout(8_000),
      });
      const kind = String(reply ?? '').trim().toLowerCase();
      if (kind.startsWith('action')) return { kind: 'enqueue_run', confidence: 0.85, reason: 'llm_classified_action' };
      if (kind.startsWith('conversation')) return { kind: 'converse', confidence: 0.85, reason: 'llm_classified_conversation' };
      emitRuntimeLog(session, `control-classify: LLM returned an unrecognized reply, answering as read-only conversation — ${JSON.stringify(kind).slice(0, 200)}`);
    } catch (err) {
      // A degradation must announce itself: silently falling through here
      // hides the difference between "no LLM configured" (expected) and "the
      // configured LLM is failing every call" (a real problem) — both would
      // otherwise look identical from the Shell or serve UI.
      emitRuntimeLog(session, `control-classify: LLM call failed, answering as read-only conversation — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // A choice menu IS the block the reader complains about: while a run is
  // active, every unanswered message turned into a menu. Falling back to
  // read-only conversation keeps the chat usable — a wrong converse only
  // answers as chat, it can never mutate or queue anything.
  return { kind: 'converse', confidence: 0.3, reason: 'fallback_to_readonly_conversation' };
}

function isAuthorized(request, token) {
  if (!token) return true;
  const authorization = request.headers.authorization ?? '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (constantTimeEqual(bearer, token)) return true;
  return constantTimeEqual(headerValue(request.headers['x-runtime-token']), token);
}

function headerValue(value) {
  if (Array.isArray(value)) return value[0] ?? '';
  return typeof value === 'string' ? value : '';
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left), 'utf8');
  const rightBuffer = Buffer.from(String(right), 'utf8');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(`${JSON.stringify(value)}\n`);
}

function sendHtml(response, statusCode, html) {
  response.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(html);
}

// Mirrors serve's cookie (same name, flags and lifetime) so one runtime-issued
// session is also the one serve validates. Secure only when the request
// already arrived over TLS — a localhost HTTP install must still get the
// cookie, but a proxied HTTPS one must not leak it.
function setSessionCookie(response, token, expiresAt, request) {
  const maxAgeSeconds = Math.max(1, Math.floor((Number(expiresAt) - Date.now()) / 1000));
  const tls = Boolean(request.socket?.encrypted) || request.headers['x-forwarded-proto'] === 'https';
  const secure = tls ? '; Secure' : '';
  response.setHeader(
    'Set-Cookie',
    `wiki_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`,
  );
}

function readRequiredPatchId(body, response) {
  const patchId = String(body.patchId ?? body.id ?? '').trim();
  if (!patchId) {
    sendJson(response, 400, { error: 'Missing patchId.' });
    return null;
  }
  return patchId;
}

function readOptionalNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readOptionalList(value) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error('Request body too large.'));
        request.destroy();
      }
    });
    request.on('end', () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    request.on('error', reject);
  });
}
