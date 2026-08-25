# OpenBot production release design

**Status:** implementation target
**Date:** 2026-08-26
**Repository authority:** `pmwasim/OpenBot`
**Release constraint:** zero OpenBot spend; no mandatory hosted service, account, license, or paid CI

## Objective

Turn the current Phase 0 control-plane preview into a free, self-hostable first production release that
can complete useful local work while preserving the product boundary in the PRD: every consequential
action is explicit, policy-evaluated, approval-bound, auditable, recoverable, and executed inside a
task workspace.

The release is local-first. Ollama is the default provider and the only provider available when
`OPENBOT_LOCAL_ONLY` is enabled. An OpenAI-compatible provider is optional and must never be required
for the product to boot or for local tasks to run.

## Release architecture

### Daemon and state

The Node daemon remains dependency-light and loopback-first. `lib/store.mjs` is the source of truth:
an append-only JSONL event log with an exclusive lock, atomic replacement, legacy migration, and a
reconstructed projection. Every task, action, approval, worker result, pause, resume, cancellation,
error, and recovery decision is an event. The projection is a read model, never a second mutable state
file.

Tasks have stable IDs, owner, provider, workspace, kind, prompt, status, timestamps, and a monotonically
ordered event sequence. A proposed action has its own immutable action ID and one-time approval binding;
approval for one action can never authorize another action.

### Worker boundary

`lib/workers.mjs` exposes one narrow worker interface:

- `file`: read, write, append, and list only inside the task workspace;
- `shell`: run an explicit command in the task workspace as the daemon's unprivileged user. Linux
  production mode requires rootless `bubblewrap`, mounts only the task workspace read-write, and
  disables the network namespace; a bounded allowlist mode is available only for trusted development
  hosts;
- `browser`: fetch an explicitly supplied HTTPS/HTTP URL only when local-only mode is off and the host
  is allowlisted; private, loopback, metadata, file, and non-HTTP targets are refused.

Workers do not receive deployment secrets. Paths are resolved beneath a task-owned workspace, symlinks
are rejected when they would escape it, outputs are bounded, and every worker call produces proposal,
decision, start, result, or error events. No worker is invoked from free-form chat text: the daemon
accepts a structured action request so the evidence shown for approval is exactly what will execute.

### Execution and recovery

`lib/executor.mjs` owns the task lifecycle. An allowed task starts immediately; a gated task remains
`waiting_approval`. Approval changes it to `pending` and schedules execution. The executor maintains a
per-process active-task map, refuses duplicate starts, emits heartbeats, and marks an interrupted task
`recoverable` rather than silently replaying an external side effect. `resume` creates a new execution
attempt with a new action ID and therefore requires a fresh approval for consequential work.

The API exposes task creation, task inspection, event listing, SSE event streaming, approval, pause,
cancel, resume, and audit-bundle export. CLI commands call the same HTTP API when the daemon is running
and retain direct-store operation for offline inspection and local administration.

### Provider boundary

The provider hub keeps Ollama and OpenAI-compatible adapters behind one interface. Model discovery,
provider selection, request timeout, and secret redaction stay in the hub. Local-only mode rejects every
non-local provider before a request is made. Provider metadata in `/api/config` and exported audit data
never includes keys.

### Client surface

The existing web dashboard becomes the canonical local desktop client: it consumes the task API and SSE
stream, shows exact proposed actions and results, and exposes approve/pause/cancel/resume/export controls.
An Ubuntu `.desktop` launcher and `desktop/openbot.mjs` wrapper start or connect to the loopback daemon
and open the same audited client, keeping the release zero-dependency and installable without a hosted
account. The CLI remains first-class and reports non-zero status for rejected, failed, or unavailable
tasks.

## Security and failure behavior

- Loopback binding remains the default; non-loopback binding requires an explicit override and emits a
  warning. The release docs must state that this override is not an authentication system.
- Request bodies, streamed output, task prompts, worker output, and audit exports are bounded.
- Shell and file paths cannot escape the task workspace; browser targets cannot reach private or cloud
  metadata addresses.
- Approval records carry the exact action payload digest and are consumed once by the executor.
- Errors name the failed boundary without returning provider keys, command environment, or raw secret
  values.
- A worker crash or daemon restart produces an observable recoverable state; no approved action is
  automatically repeated.

## Verification gates

The release harness must prove, not merely inspect:

1. clean install and syntax checks;
2. store migration, lock/atomic persistence, and recovery projection;
3. task creation and status transitions through API and CLI;
4. policy denial, approval binding, one-time approval consumption, and audit events;
5. workspace escape and symlink refusal;
6. shell/file/browser worker success and bounded failure paths;
7. local-only outbound-provider and browser denial;
8. SSE delivery and dashboard controls;
9. daemon restart preserving completed and recoverable task history;
10. release packaging, license, docs, and no-secret checks.

The first production tag must not be cut until these checks pass on the release commit. A GitHub Release
is only the final publication step; it is not evidence that the product is production-ready.
