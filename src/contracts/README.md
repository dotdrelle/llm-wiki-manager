# Runtime Contracts

Versioned JSON Schema-like contracts live in `schemas.js`.

Current schema version: `1`.

Validated boundaries:

- `_activity` after normalization in `core/activity.js`
- `AgentRunEvent` creation and dispatch in `core/agentEvents.js`
- structured plan and plan patch normalization
- runtime `/run` and `/control` request payloads

Validation is enabled when `WIKI_MANAGER_VALIDATE_CONTRACTS=1`, `CI=true`, or
`NODE_ENV` is set to a non-production value. Schemas tolerate additional fields
so agents can extend payloads without breaking older consumers.
