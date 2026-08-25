# OpenBot production core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable, policy-bound local task runtime that can execute approved file, shell, and browser-research actions with CLI/API parity and recoverable audit history.

**Architecture:** Keep the dependency-free Node daemon and append-only JSONL store. Add a focused worker layer that receives structured action payloads, an executor that owns task transitions and one-time approval consumption, and HTTP/SSE routes that expose the same state to the CLI and web client. Local-only mode remains the default and blocks external provider/browser access before network I/O.

**Tech Stack:** Node.js 22 ESM, built-in `http`, `child_process`, `fs/promises`, `crypto`, `URL`, and `fetch`; no new runtime dependency.

**Spec:** `docs/release-design.md`

## Global Constraints

- Zero OpenBot spend; no mandatory hosted service, account, license, or paid CI.
- Ollama is the default provider and the only provider available when `OPENBOT_LOCAL_ONLY` is enabled.
- Loopback binding is the default; non-loopback binding requires explicit `OPENBOT_ALLOW_NON_LOOPBACK=1`.
- Every consequential action is explicit, policy-evaluated, approval-bound, auditable, and recoverable.
- Worker paths remain inside a task-owned workspace and all outputs are bounded.
- No free-form chat message may be executed as a command, URL, or file mutation.

---

### Task 1: Extend the event-sourced task projection

**Files:**
- Modify: `lib/store.mjs`
- Modify: `lib/policy.mjs`
- Test: `scripts/release_harness.mjs`

**Interfaces:**
- Produces `store.createTask({ prompt, kind, action, provider, workspace, owner })` returning `{ task, approval, policy }`.
- Produces `store.appendTaskEvent(taskId, type, payload)` returning the persisted event.
- Produces `store.consumeApproval(id, actionDigest)` returning the approved action or a 409 error.
- Produces `store.exportTask(taskId)` returning `{ task, events }` with secrets redacted.

- [ ] **Step 1: Write failing harness assertions** for a structured action digest, task action metadata, one-time approval consumption, export shape, and `recoverable` status.

```js
const action = { tool: 'file.write', path: 'notes/today.md', content: 'local evidence' };
const created = await first.createTask({ prompt: 'write notes', kind: 'file', action });
if (created.task.status !== 'pending') throw new Error('safe file action should start pending');
const gated = await first.createTask({ prompt: 'run cleanup', kind: 'shell', action: { tool: 'shell.exec', command: 'rm -rf output' } });
if (!gated.approval?.actionDigest) throw new Error('approval missing action digest');
await first.consumeApproval(gated.approval.id, gated.approval.actionDigest);
await assertRejects(() => first.consumeApproval(gated.approval.id, gated.approval.actionDigest), 409);
const bundle = await first.exportTask(gated.task.id);
if (!bundle.events.some((event) => event.type === 'approval.consumed')) throw new Error('consume event missing');
```

- [ ] **Step 2: Run `npm run check` and verify the new assertions fail** because action metadata and consume/export methods do not exist.
- [ ] **Step 3: Implement immutable action payload handling** using canonical JSON and SHA-256. Store only redacted action metadata in projection responses, keep the original structured action in the event payload needed by the executor, and reject digest mismatches.
- [ ] **Step 4: Add task event projection** for `task.action_proposed`, `task.policy_decision`, `approval.consumed`, `task.execution_started`, `task.execution_result`, `task.execution_error`, and `task.recoverable`.
- [ ] **Step 5: Run `npm run check` and confirm the new assertions pass** while all existing 21 checks remain green.
- [ ] **Step 6: Commit** with `git add lib/store.mjs lib/policy.mjs scripts/release_harness.mjs && git commit -m "feat: persist structured task actions and audit exports"`.

### Task 2: Add workspace-safe workers

**Files:**
- Create: `lib/workers.mjs`
- Test: `scripts/release_harness.mjs`
- Modify: `lib/config.mjs`

**Interfaces:**
- Produces `createWorkerHub({ dataDir, localOnly, browserAllowlist, limits })`.
- `workerHub.run(action, { taskId, workspace })` returns `{ ok, output, metadata }` or throws an error with `statusCode`.
- Supports `file.read`, `file.write`, `file.append`, `file.list`, `shell.exec`, and `browser.fetch`.

- [ ] **Step 1: Write failing worker assertions** covering successful file write/read/list, traversal rejection, symlink escape rejection, bounded shell output, timeout, local-only browser rejection, private-host rejection, and allowlisted browser fetch.

```js
const hub = createWorkerHub({ dataDir, localOnly: true, browserAllowlist: ['example.com'] });
await hub.run({ tool: 'file.write', path: 'safe/a.txt', content: 'ok' }, context);
await assertRejects(() => hub.run({ tool: 'file.read', path: '../outside' }, context), 400);
await assertRejects(() => hub.run({ tool: 'browser.fetch', url: 'https://example.com' }, context), 403);
```

- [ ] **Step 2: Run the focused harness and verify the worker assertions fail** because `lib/workers.mjs` is absent.
- [ ] **Step 3: Implement `resolveWorkspacePath`** with absolute-path rejection, separator normalization, `realpath` checks for existing parents, and a final containment check against the task workspace.
- [ ] **Step 4: Implement file operations** with byte limits, atomic writes for `file.write`, append limits, and directory-only recursive listing with relative paths.
- [ ] **Step 5: Implement shell execution** with `spawn` using `shell: false`, task workspace cwd, a fixed environment allowlist, timeout kill, stdout/stderr caps, and no inherited deployment secret variables.
- [ ] **Step 6: Implement browser fetch** with HTTP(S)-only URL parsing, DNS/IP private-range rejection, local-only refusal, host allowlist matching, timeout, and response-size caps.
- [ ] **Step 7: Run the harness and confirm all worker assertions pass**; verify no secret-bearing environment value appears in worker output.
- [ ] **Step 8: Commit** with `git add lib/workers.mjs lib/config.mjs scripts/release_harness.mjs && git commit -m "feat: add bounded local task workers"`.

### Task 3: Add the task executor and recovery state machine

**Files:**
- Create: `lib/executor.mjs`
- Modify: `lib/store.mjs`
- Test: `scripts/release_harness.mjs`

**Interfaces:**
- Produces `createExecutor({ store, workers, limits })`.
- `executor.start(taskId)` returns a promise and refuses duplicate active starts.
- `executor.onTask(taskId, listener)` subscribes to persisted task events.
- `executor.shutdown()` marks active tasks recoverable without replaying them.

- [ ] **Step 1: Write failing assertions** for allowed execution, approval-gated execution, duplicate-start refusal, pause/cancel behavior, worker error to `failed`, and shutdown to `recoverable`.
- [ ] **Step 2: Run the harness to confirm the state-machine assertions fail** because the executor is absent.
- [ ] **Step 3: Implement the executor** as a per-process active-task map. Before worker invocation append proposal/decision/start events; after invocation append result or error and set final status.
- [ ] **Step 4: Implement approval handoff** so the server calls `executor.start` only after `store.consumeApproval` succeeds; a consumed approval cannot be reused after restart or by another task.
- [ ] **Step 5: Implement pause/cancel checks** before starting work and between bounded worker steps. A running shell process receives SIGTERM, then SIGKILL after the grace period; the result is `cancelled` or `recoverable` according to whether completion was known.
- [ ] **Step 6: Implement shutdown recovery** and ensure no `approval.consumed` event is replayed automatically on daemon start.
- [ ] **Step 7: Run the full harness and confirm all transitions and recovery checks pass.**
- [ ] **Step 8: Commit** with `git add lib/executor.mjs lib/store.mjs scripts/release_harness.mjs && git commit -m "feat: execute tasks with recoverable lifecycle"`.

### Task 4: Expose task API, SSE, audit export, and provider metadata

**Files:**
- Modify: `server.mjs`
- Modify: `lib/config.mjs`
- Modify: `lib/provider.mjs`
- Test: `scripts/release_harness.mjs`

**Interfaces:**
- `POST /api/tasks` accepts `{ prompt, kind, action, provider, workspace }` and returns 201 with task/approval/policy.
- `GET /api/tasks`, `GET /api/tasks/:id`, `GET /api/tasks/:id/events` return projected state and bounded event history.
- `GET /api/tasks/:id/stream` returns `text/event-stream` and sends `task`, `event`, and terminal `done` frames.
- `POST /api/tasks/:id/:action` accepts `approve`, `reject`, `pause`, `cancel`, or `resume`.
- `GET /api/tasks/:id/export` returns an attachment-safe JSON audit bundle.
- `GET /api/config` returns public provider, local-only, limits, and bind metadata without secrets.

- [ ] **Step 1: Write failing HTTP assertions** for task create/list/show, approval flow, SSE headers/frame, export content-disposition, provider metadata redaction, and invalid action validation.
- [ ] **Step 2: Run the harness and confirm the routes fail** with 404.
- [ ] **Step 3: Wire `createExecutor` and `createWorkerHub` into `server.mjs`** and add body validation for structured actions, max prompt/action sizes, and supported kinds.
- [ ] **Step 4: Implement task routes** with consistent JSON errors, no-store headers, and ownership set to `local` for the single-user release.
- [ ] **Step 5: Implement SSE subscriptions** using an in-process listener registry backed by the event log; send a replay from `Last-Event-ID` or query cursor before live events.
- [ ] **Step 6: Implement graceful shutdown** on SIGINT/SIGTERM: stop accepting new tasks, call executor shutdown, close the HTTP server, and release the store lock.
- [ ] **Step 7: Run all harness checks and confirm API, SSE, and shutdown behavior pass.**
- [ ] **Step 8: Commit** with `git add server.mjs lib/config.mjs lib/provider.mjs scripts/release_harness.mjs && git commit -m "feat: expose production task API and event stream"`.

### Task 5: Bring CLI to API parity

**Files:**
- Modify: `cli/openbot.mjs`
- Modify: `README.md`
- Test: `scripts/release_harness.mjs`

**Interfaces:**
- CLI commands `run`, `list`, `show`, `approve`, `reject`, `pause`, `cancel`, `resume`, `logs`, and `export` use `OPENBOT_SERVER_URL` when set, otherwise direct local store for offline inspection.
- `run` supports `--kind`, `--tool`, `--path`, `--content`, `--command`, `--url`, `--model`, and `--wait`.
- Non-zero exit codes: 2 invalid input, 3 unavailable daemon/provider, 4 rejected/failed/cancelled task.

- [ ] **Step 1: Write failing CLI assertions** for structured task submission, approval, wait/terminal exit code, export file output, and server-unavailable exit code.
- [ ] **Step 2: Run the focused harness to confirm new CLI flags and commands fail.**
- [ ] **Step 3: Implement a small HTTP client** with request timeout, JSON error normalization, and SSE-free polling for `--wait`.
- [ ] **Step 4: Implement structured action flag parsing** without ever converting arbitrary prompt text into an executable action.
- [ ] **Step 5: Implement terminal-state exit codes** and keep direct-store commands usable when no daemon URL is configured.
- [ ] **Step 6: Update CLI help and README examples** for a no-account local task flow.
- [ ] **Step 7: Run the harness and commit** with `git add cli/openbot.mjs README.md scripts/release_harness.mjs && git commit -m "feat: make CLI a production task client"`.

### Task 6: Replace the preview dashboard with the audited task client

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Test: `scripts/release_harness.mjs`

**Interfaces:**
- The dashboard renders task list/status, exact proposed action details, approval controls, live event stream, recovery controls, and audit export.
- Chat remains planning-only and submits no executable action.
- All user-visible values are inserted with `textContent` or DOM APIs, never interpolated into HTML.

- [ ] **Step 1: Add harness checks** that the dashboard contains task controls, an SSE client, export action, and no `innerHTML` assignment using untrusted response values.
- [ ] **Step 2: Implement task creation form** with explicit action-type fields and a visible local-only/network warning.
- [ ] **Step 3: Implement task rendering** from `/api/tasks`, exact action display, status badges, and one-time approval buttons.
- [ ] **Step 4: Implement `EventSource` replay/live handling** and reconnect from the last event ID without duplicating rows.
- [ ] **Step 5: Implement pause/cancel/resume/export controls** and error states that name the failed operation without exposing secrets.
- [ ] **Step 6: Run syntax checks, harness checks, and a manual local dashboard smoke test; commit** with `git add public && git commit -m "feat: ship audited task dashboard"`.

### Task 7: Add Ubuntu desktop launcher and release packaging

**Files:**
- Create: `desktop/openbot.mjs`
- Create: `desktop/openbot.desktop`
- Create: `desktop/install.sh`
- Modify: `README.md`
- Modify: `package.json`
- Test: `scripts/release_harness.mjs`

**Interfaces:**
- `npm run desktop` starts the loopback daemon if needed and opens the dashboard through `xdg-open`.
- `desktop/install.sh` installs the launcher under `~/.local/share/applications` and refuses non-Linux hosts with a clear message.
- No desktop launcher runs OpenBot on a non-loopback host.

- [ ] **Step 1: Write failing packaging assertions** for launcher paths, executable permissions, loopback defaults, and package script.
- [ ] **Step 2: Implement the wrapper** using `spawn`, health polling, and `xdg-open`; keep child PID cleanup on SIGINT/SIGTERM.
- [ ] **Step 3: Implement the `.desktop` file and installer** with absolute resolved paths and no shell-evaluated user input.
- [ ] **Step 4: Add `npm run desktop` and Ubuntu setup docs** with explicit limitation that the desktop client is the local web UI in a system launcher.
- [ ] **Step 5: Run packaging checks and commit** with `git add desktop package.json README.md scripts/release_harness.mjs && git commit -m "feat: add Ubuntu desktop launcher"`.

### Task 8: Release verification and publication handoff

**Files:**
- Modify: `scripts/release_harness.mjs`
- Modify: `README.md`
- Create: `CHANGELOG.md`
- Create: `RELEASE.md`
- Modify: `package.json`

- [ ] **Step 1: Add release checks** for syntax, no secret literals, license presence, docs consistency, clean data-dir startup, worker benchmark fixtures, and audit export redaction.
- [ ] **Step 2: Run `npm run check` from a clean checkout** and record the exact pass count.
- [ ] **Step 3: Run the file, shell, browser-research, approval, recovery, CLI, SSE, and desktop smoke journeys** against the release branch with local-only mode enabled.
- [ ] **Step 4: Update version, changelog, release notes, and install/rollback instructions** only after all gates are green.
- [ ] **Step 5: Create an annotated tag and GitHub Release from the owner repository** using the authenticated `gh` session, with the commit SHA and harness result in the release notes; do not publish if any gate is red.
- [ ] **Step 6: Verify the public tag/release, checkout reproducibility, and release asset hashes; update the plan and goal only when every PRD P0 gate has authoritative evidence.**
