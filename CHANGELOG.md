# Changelog

## 0.4.30 — 2026-08-27

Added safe operator-owned local connectors for real bot extensibility.

- Register bounded read-only HTTP connectors with exact host and path permissions through the API, dashboard, local CLI, or shared daemon CLI.
- Add the `connector.fetch` agent capability with approval before every request, disabled redirects, GET-only behavior, 64 KiB response limits, 10-second timeouts, and connector-definition-bound action approvals.
- Preserve loopback defaults, workspace containment, redaction, zero mandatory spend, old-laptop portability, and brand-neutral public surfaces.

## 0.4.29 — 2026-08-27

Clarified the browser network security boundary for the v0.4.28 research-host capability.

- Document exact host configuration, loopback defaults, redirect/credential restrictions, approval behavior, and operator DNS/network responsibility in `SECURITY.md`.
- Preserve zero mandatory spend, old-laptop portability, local-first defaults, and brand-neutral public surfaces.

## 0.4.28 — 2026-08-27

Added opt-in browser research hosts while preserving the local-first boundary.

- Keep browser access restricted to `127.0.0.1` and `localhost` by default; operators can configure an exact host list with `OPENBOT_BROWSER_ALLOW_HOSTS`.
- Thread the allowlist through policy, the browser worker, the daemon, CLI actions, and the read-only Settings view; redirects remain disabled.
- Keep every browser fetch approval-gated before content is saved into the task workspace, with the existing path containment and audit controls.
- Preserve zero mandatory spend, old-laptop portability, local-only defaults, and brand-neutral public surfaces.

## 0.4.27 — 2026-08-27

Made named bots usable as persistent conversations across clients.

- Expose bounded named-bot history at `GET /api/bots/:id/messages`, returning only redacted conversation message fields.
- Load a selected bot's durable conversation in the dashboard and refresh it after task completion, failure, or cancellation.
- Add `openbot bot history <id>` for local or daemon-routed conversation inspection.
- Preserve task approval gates, workspace/provider boundaries, zero mandatory spend, old-laptop portability, and brand-neutral public surfaces.

## 0.4.26 — 2026-08-27

Added bounded typed task-artifact inventory and selective access.

- Expose `GET /api/tasks/:id/artifacts` for files actually produced by successful file or browser actions, with typed metadata and a 50-item cap.
- Expose scoped text preview at `/api/tasks/:id/artifacts/:path`; it serves only an inventoried workspace-relative artifact, rechecks workspace containment, redacts content, and caps previews at 64 KiB.
- Add dashboard artifact links and `openbot artifacts <task-id>` for local or daemon-routed inspection.
- Preserve approval gates, no implicit directory creation, zero mandatory spend, old-laptop portability, and brand-neutral public surfaces.

## 0.4.25 — 2026-08-27

Hardened structured task results and added CLI parity.

- Bound result text, action arguments, action results, and action count in the concise task-result contract, with secret redaction reapplied before delivery.
- Add `openbot result <task-id>` for local stores and `openbot result --daemon <task-id>` for the shared daemon.
- Preserve the same dashboard/API result view, full audit export, approval and workspace boundaries, zero mandatory spend, old-laptop portability, and brand-neutral public surfaces.

## 0.4.24 — 2026-08-27

Added concise structured result views for durable tasks.

- Expose `GET /api/tasks/:id/result` with the task outcome, bounded action summaries, status, and update timestamp without returning the full event history.
- Show a safe result preview and structured-result link on recent-task cards, while retaining the full audit view and downloadable audit artifact.
- Preserve DOM-safe rendering, task-id binding, redaction, no-cache responses, zero mandatory spend, old-laptop portability, and brand-neutral public surfaces.

## 0.4.23 — 2026-08-27

Added portable task-result delivery from the dashboard.

- Expose `GET /api/tasks/:id/export` as a no-cache JSON download containing only the requested task and its redacted event history.
- Add a dashboard Download audit action alongside the existing read-only audit view.
- Keep the artifact bounded to durable local task data, use a fixed safe filename, and preserve zero mandatory spend, approval/workspace boundaries, old-laptop portability, and brand-neutral public surfaces.

## 0.4.22 — 2026-08-27

Added a safe read-only effective-settings view to the dashboard.

- Expose `/api/config` with the same redacted public configuration already available to the CLI.
- Wire the dashboard Settings control to show provider mode, local-only state, resource profile, model protocol/endpoint, daemon binding, and agent limits.
- Keep credentials out of the response, use DOM-safe rendering, and require environment configuration plus daemon restart for changes.
- Preserve zero mandatory spend, old-laptop portability, approval and workspace boundaries, and brand-neutral public surfaces.

## 0.4.21 — 2026-08-27

Added optional dashboard task-completion notifications.

- Let an operator explicitly enable browser notifications from the dashboard for tasks started in that session.
- Notify on completion, failure, or cancellation without polling beyond the existing live activity and fallback paths.
- Degrade safely when the browser lacks notification support or the operator denies permission; no OS service, account, dependency, or mandatory spend is added.
- Preserve local-first defaults, approval gates, provider/model boundaries, old-laptop portability, and brand-neutral public surfaces.

## 0.4.20 — 2026-08-27

Added an opt-in compatible remote provider alongside the local-first provider.

- Support model discovery and structured agent requests through a generic `/v1/models` and `/v1/chat/completions` compatible endpoint.
- Let dashboard and CLI operators choose a provider and model per task; task metadata and audit events retain the selected provider.
- Keep local-only mode as the default, reject external providers unless explicitly enabled, bound remote requests, and redact provider credentials and endpoint userinfo.
- Preserve zero mandatory spend, old-laptop portability, approval gates, workspace containment, cancellation, and brand-neutral public surfaces.

## 0.4.19 — 2026-08-27

Added explicit per-task local model selection in the dashboard.

- Populate the model selector from the daemon's health response and preserve the operator's choice across refreshes.
- Send the selected model for new tasks, resumed tasks, and approval continuations; the server remains authoritative for availability and local-only policy.
- Keep the first installed local model as the automatic fallback and add release coverage for the dashboard contract.
- Preserve zero mandatory spend, local-first defaults, bounded work, and brand-neutral public surfaces.

## 0.4.18 — 2026-08-27

Added low-overhead live task activity streaming.

- Expose `/api/tasks/:id/events/stream` as a bounded authenticated server-sent event stream backed by durable task events.
- Replay events after the requested offset, deliver new events as they are appended, and close at final task state or the server time limit.
- Use the stream in the dashboard with an automatic offset-polling fallback for older or incompatible clients.
- Keep task results redacted and preserve existing approval, workspace, cancellation, and audit boundaries.
- Expand release verification to cover durable stream replay and completion behavior.

## 0.4.17 — 2026-08-27

Added lightweight CLI execution and follow mode.

- Add `run --daemon --follow` to start a durable task through the local daemon and follow its bounded event history.
- Return the final persisted task and event records in JSON mode, while human-readable mode reports bounded event milestones on stderr.
- Keep the existing create-only `run` behavior and all task, workspace, approval, cancellation, and resource limits intact unless `--follow` is explicitly selected.
- Add daemon client helpers and end-to-end CLI coverage for asynchronous task execution.

## 0.4.16 — 2026-08-27

Completed in-flight cancellation hardening.

- Claim new and pending tasks before controller execution and register their abort controller first.
- Propagate pause/cancel signals to local model requests, shell child processes, and browser fetches.
- Preserve cancelled state when control arrives during startup or model work.
- Expand end-to-end, controller, and worker regression coverage.
- Run dashboard tasks asynchronously through a durable `/run` boundary, persist final replies, and keep task controls available while work runs.
- Preserve bounded named-bot conversation history for asynchronously started tasks.

## 0.4.15 — 2026-08-27

Hardened task-start and cancellation races.

- Claim new and pending tasks before starting the agent controller.
- Register cancellation before the claim so a concurrent pause or cancel cannot be overwritten by late startup.
- Preserve durable cancelled/paused state and prevent false execution after a stop request.
- Expand end-to-end coverage for in-flight cancellation through the daemon.

## 0.4.14 — 2026-08-27

Added in-flight cooperative cancellation.

- Propagate task stop signals from the daemon to local model requests, shell children, and browser fetches.
- Abort active work after durable pause/cancel transitions while preserving task and audit history.
- Add end-to-end and worker-level regression coverage for cancellation.
- Keep file operations bounded at action boundaries and document that completed effects cannot be undone.

## 0.4.13 — 2026-08-27

Hardened cooperative task stopping.

- Recheck durable pause/cancel state before turns, after model responses, and before actions.
- Return a paused or cancelled task without writing a false completion event after operator control.
- Add a regression check for cancellation during a model call.
- Preserve the existing approval, workspace, audit, and bounded-loop boundaries.

## 0.4.12 — 2026-08-27

Added dashboard task control parity.

- Pause pending, running, or approval-bound tasks from recent-task cards.
- Resume recoverable tasks and cancel all nonterminal controllable tasks from the dashboard.
- Route controls through the existing durable task-state endpoint and refresh activity after each action.
- Expand release verification to cover the dashboard task-control contract.

## 0.4.11 — 2026-08-27

Added dashboard editing parity for operator-owned configuration.

- Edit named bot names, roles, and instructions inline without losing conversation history or task associations.
- Edit local skill names, descriptions, and instructions without losing durable references.
- Edit workspace-scoped memory keys and values without changing their originating workspace.
- Reuse the existing validated, redacted PATCH API and add safe DOM-only editor controls with cancel and error recovery.
- Expand release verification to cover the dashboard editing contract alongside the existing API, CLI, and daemon paths.

## 0.4.10 — 2026-08-27

Added workspace-memory editing parity.

- Update a local memory fact's key or value with `memory update <id>`.
- Support direct-local and shared-daemon updates through the existing bounded validation and redaction paths.
- Preserve the memory's durable identity and originating workspace scope during edits.
- Expand release verification to cover store, API, local CLI, and daemon-routed memory updates.

## 0.4.9 — 2026-08-27

Added reusable skill update parity.

- Update a local skill's name, description, or instructions with `skill update <id>`.
- Support direct-local and shared-daemon updates through the existing bounded validation and redaction paths.
- Preserve skill identity and bot/routine references while refining reusable guidance.
- Expand release verification to cover local and daemon-routed skill updates.

## 0.4.8 — 2026-08-27

Added named-bot profile update parity.

- Update a bot's name, role, instructions, workspace, or selected skill with `bot update <id>`.
- Support direct-local and shared-daemon updates while retaining server-side validation, redaction, duplicate-name checks, and skill lookup.
- Keep existing bot conversation history and task associations intact during profile updates.
- Expand release verification to cover both local and daemon-routed profile changes.

## 0.4.7 — 2026-08-27

Added opt-in user-level daemon service integration.

- Generate and inspect macOS LaunchAgent or Linux systemd user-service manifests with `service info`.
- Install, enable, disable, and remove the per-user daemon service with `service install` and `service uninstall`.
- Support `service install --dry-run` and `service uninstall --dry-run` without writing files or invoking the service manager.
- Keep loopback validation, explicit LAN authentication, the portable detached launcher, and the no-dependency fallback intact.
- Expand release verification to cover cross-platform manifest generation and unsupported-platform behavior.

## 0.4.6 — 2026-08-27

Added a lightweight desktop launcher for the local dashboard.

- Start or reuse the portable daemon and open the local dashboard with `node cli/openbot.mjs desktop`.
- Support `--no-open` for headless sessions and older environments without a graphical shell.
- Use the host's existing browser and stock Node.js facilities without adding a native runtime, hosted service, or paid dependency.
- Preserve loopback defaults, explicit LAN authentication, daemon lifecycle checks, and the shared task state used by CLI and dashboard clients.
- Expand release verification to cover the launcher against a live detached daemon.

## 0.4.5 — 2026-08-27

Added shared-daemon administration parity for local bots, skills, memory, and routines.

- Route `memory`, `skill`, `bot`, and `routine` administration through the shared daemon with `--daemon`.
- Keep durable profiles, reusable guidance, workspace-scoped facts, schedules, and run history in the daemon-owned store.
- Support daemon-routed named-bot chat and Run now without requiring a second populated local data directory.
- Preserve direct local administration, workspace containment, approval boundaries, redaction, and bounded agent execution.
- Expand release verification to cover the complete shared-daemon administration path.

## 0.4.4 — 2026-08-27

Added daemon-routed CLI task control.

- Route `pause`, `resume`, and `cancel` through the shared daemon with `--daemon`.
- Resume paused tasks through the server-owned bounded agent loop without changing task identity.
- Preserve direct local commands and existing status-transition, approval, workspace, and audit boundaries.
- Expand release verification to cover remote pause, resume, and cancel against a live server.

## 0.4.3 — 2026-08-27

Added daemon-routed CLI task management parity.

- Route `list`, `show`, `logs`, `approve`, and `reject` through the shared daemon with `--daemon`.
- Keep task inspection, event history, and approval decisions on the daemon-owned store when the CLI data directory is empty or separate.
- Preserve existing direct local commands and the current authentication, approval, redaction, and workspace boundaries.
- Expand release verification to prove remote CLI task management against a running server.

## 0.4.2 — 2026-08-27

Added lightweight live task activity visibility.

- Expose `/api/tasks/:id/events?after=<offset>` for incremental, durable task-event reads.
- Show the latest task activity in the dashboard and poll only while work is pending, running, or waiting for approval.
- Keep event output bounded by the existing redaction and local-access boundaries without adding a runtime dependency or permanent connection.
- Expand release verification to cover event retrieval and offset exhaustion.

## 0.4.1 — 2026-08-27

Added opt-in shared-daemon CLI chat parity.

- Send `openbot chat --daemon` through the local daemon so the CLI and dashboard use the same server-owned task, approval, audit, routine, and recovery state.
- Support the configured daemon URL and bearer token for explicitly enabled LAN use without changing loopback-only defaults.
- Preserve the direct local CLI controller path for offline administration and compatibility.
- Expand release verification to cover a daemon-routed CLI conversation and server-owned task persistence.

## 0.4.0 — 2026-08-27

Added a portable local daemon lifecycle for practical background use.

- Start OpenBot in the foreground or with `openbot start --detach` without adding a runtime dependency or paid service.
- Add `status` and `stop` commands with process identity, health reporting, duplicate-start protection, stale-record cleanup, and clean shutdown.
- Keep the scheduler and durable task store active after the terminal closes while the host remains powered on.
- Write a local daemon log under the configured data directory and document the host-local boundary for sleep and shutdown.
- Expand release verification to cover the detached lifecycle and daemon process record.

## 0.3.9 — 2026-08-27

Added opt-in local model protocol compatibility.

- Support local runtimes exposing `/v1/models` and `/v1/chat/completions` through `OPENBOT_MODEL_PROTOCOL=chat-completions`.
- Preserve the existing native local protocol as the default and retain loopback-only checks in local-only mode.
- Normalize model listings and reply formats across both protocols, including structured agent replies.
- Document the configuration and expand the release harness with a live protocol adapter fixture and configuration checks.

## 0.3.8 — 2026-08-27

Added restart-safe task recovery.

- Resume tasks left in `running` state after a daemon or worker interruption through the API, CLI, or dashboard.
- Preserve the original task identity, workspace, bot association, skill selection, and append-only event history during recovery.
- Add a dashboard Resume control for pending, running, and paused tasks.
- Expand release verification to 80 checks, including API, CLI, and dashboard recovery coverage.
- Keep recovery bounded by the active resource profile and the existing approval, workspace, and audit controls.

## 0.3.7 — 2026-08-27

Added durable named local bots.

- Create, list, chat with, and delete named bot profiles from the dashboard, HTTP API, or CLI.
- Persist each bot's role, instructions, workspace, optional skill, and bounded conversation history locally.
- Connect routines and tasks to a named bot while preserving workspace checks, approval gates, and audit history.
- Keep provider labels and configuration language neutral across public code, documentation, CLI output, and dashboard copy.
- Expanded the release harness with bot persistence, API, CLI, and public brand-neutrality checks.

## 0.3.6 — 2026-08-27

Hardened host-mode file access against symlink replacement races.

- Open file handles with the operating-system no-follow flag and verify the opened file identity before reading or writing.
- Keep writes on the verified descriptor so a later path replacement cannot redirect the write outside the workspace.
- Require destination parent directories to already exist instead of recursively creating them through a path that may be replaced concurrently.
- Expanded the release harness to 73 checks, including symlink escape rejection.

## 0.3.5 — 2026-08-27

Added the first usable local routine system.

- Create, list, pause, enable, and run routines from the dashboard, API, or CLI.
- Store explicit interval/daily schedules, task links, last status, and the 20 most recent run records.
- Run routines through the same bounded agent controller and approval gates as interactive tasks.
- Keep scheduling local and lightweight: it runs while the daemon is running and installs no hosted service or paid dependency.
- Expanded the release harness to 72 checks.

## 0.3.4 — 2026-08-27

Public product language is now brand-neutral.

- Removed competitor and third-party product names from public documentation, design notes, release history, and dashboard copy.
- Replaced provider-specific visible labels with neutral local-model wording without changing the local provider integration or configuration contract.
- Re-ran the complete release harness: 67 checks passed.

## 0.3.3 — 2026-08-27

Added reusable local skills for persistent, operator-controlled task behavior.

- Skills can be created, listed, selected, and deleted from the dashboard, HTTP API, or CLI.
- Skill instructions are bounded, redacted before persistence, explicitly selected, and recorded in task audit metadata.
- Skills remain declarative guidance: they cannot add tools, grant permissions, cross workspace boundaries, or bypass approval gates.
- Loopback browser fetches now require approval before fetched content is written into the workspace.
- Release harness coverage expanded to 67 checks.
- Existing task workspaces and approval task IDs are now enforced at action execution.
- Approved shell diagnostics deny arbitrary Node execution and out-of-workspace `ls` paths.
- Local-only mode rejects non-loopback model-runtime URLs unless explicitly opted into remote mode.

## 0.3.2 — 2026-08-27

Added lightweight persistent memory and protected LAN mode for local teammates.

- Operator-controlled memory facts are stored locally and scoped to an explicit workspace.
- Matching memory is supplied to the agent without embeddings, background services, or cloud calls.
- Memory is manageable through the dashboard, HTTP API, and CLI.
- Credential-like values are redacted before persistence and model context.
- Non-loopback mode refuses startup without `OPENBOT_AUTH_TOKEN` and requires a bearer token on every request.
- Added live authorization regression coverage and repository security guidance.
- Release harness coverage expanded to 59 checks.

## 0.3.1 — 2026-08-27

Usability follow-up for persistent local work and older laptops.

- Added recent task history to the dashboard with direct audit links.
- Added task-history regression coverage for the HTTP API.
- Added `doctor --json` resource guidance for the `legacy` CPU-only profile.
- Kept approved task continuation, fixed-path diagnostics, and zero-cost local operation explicit.

## 0.3.0 — 2026-08-27

OpenBot’s first real local-bot release. The product now performs bounded, auditable work instead of only presenting a control panel.

- Added a strict local-model agent loop with validated structured actions.
- Added safe file reads/diffs, allowlisted shell diagnostics, and loopback browser fetches.
- Added one-shot approval gates and same-task resume after approval.
- Added CLI `chat`, dashboard workspace/action/audit UX, and fresh-state initialization without synthetic work.
- Added `legacy` CPU-only resource profile and container-free fixed-path diagnostics.
- Hardened persisted audit redaction for sensitive fields, token-like content, diffs, and action results.
- Added 49 release-harness checks covering product behavior, security boundaries, and portability.

This release remains loopback-only by default. Desktop automation, connectors, signed extensions, memory, routines, collaboration, multi-user auth, and remote workers are roadmap work. Natural-language reasoning requires an installed local model; no account or paid service is required.
