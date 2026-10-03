# Donna orchestration validation — 2026-10-03

## What was actually tested

The manager release gate passed **1,226 tests**, with no failures, cancellations
or skips. The production provider suite passed **76 tests**. These totals include
other existing work in the workspace, not just this change.

The new behavioral scenarios cover:

- Failure investigation through declared read-only tools, with workspace and
  job ownership checks; guessed writes and foreign jobs never dispatch.
- A pre-execution refusal followed by a replacement capability, fresh approval,
  execution and observed result. No conversational pseudo-task is executed.
- An autonomous read-only verification tail after an acknowledged mutation.
- Preservation of completed task evidence across plan revisions. Late queued
  activity frames cannot revive those tasks or match a new task by label.
- Multiple failures retaining their exact pre-execution evidence across
  successive revisions; one failure's correction cannot erase another failure.
- Shared task budgets across revisions, repeated-proposal refusal, bounded
  investigation, and cancellation of a nonresponsive model.
- Durable incident hints surviving a SQLite close/reopen, bounded to the last
  five hints and isolated by workspace. Switching workspaces invalidates the
  old reader until hydration in the new scope.
- Single fenced JSON decisions preceded by model prose, while multiple
  competing decision blocks are refused.

## Configured-model smoke test

A synthetic scenario was also run through the workspace's configured model,
**deepseek-v4-flash-0731**, using the manager's actual LLM client and supervisor.
It used an isolated temporary SQLite store, a synthetic capability and a mocked
read-only diagnostic provider. No real email or workspace action was executed.

The first attempt exposed two integration defects: the model substituted the
requested target for the workspace, and returned an explanation followed by a
JSON fence that the strict whole-response parser rejected. Both were corrected:
the active workspace is now explicit in facts and validation errors, and one
unambiguous fenced JSON decision is accepted before deterministic validation.

The final test observed:

| Check | Result |
| --- | --- |
| Restored incident hints included in the actual model request | Yes |
| Read-only diagnostic executed in the correct workspace | Yes, one read |
| Valid corrective task prepared | Yes |
| Original target preserved | Yes |
| Unsupported argument removed | Yes |
| Fresh approval still required | Yes |
| Investigation degraded | No |
| Real actions executed | Zero |

The synthetic model input contained a prior incident naming the unsupported
argument. This demonstrates retrieval and use of restored context in a real
model call; it does not isolate how much that hint improved the decision over
the independently clear input schema and error.

## Limits of the evidence

This is evidence of bounded agentic orchestration, not a guarantee that every
future request will be understood or completed. Alternative-plan and multi-step
scenarios use controlled model responses; the live-model check covers diagnosis
and preparation of a corrected task, not an actual external mutation. It is
not a multi-model quality evaluation or an end-to-end check of a running Serve
installation after these final corrections.

An agent's execution receipt and its verification observation remain distinct.
Providers without observation contracts remain explicitly unverified. Gmail
Sent presence is not recipient delivery, and raw file readback is not a wiki
ingestion audit. Uncertain external effects are not replayed.

Incident hints are operational audit data: failure classes, removed argument
names and revised capabilities, without request values or mail bodies. They are
not user-authored facts, preferences, approvals or proof of current state. The
existing evidenced workspace memory remains separate.
