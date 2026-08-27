# Changelog

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
