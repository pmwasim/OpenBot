# OpenBot Product Requirements Document

**Status:** Active implementation baseline
**Version:** 0.2
**Date:** 2026-08-26
**Owner:** OpenBot product/engineering

## 1. Executive summary

OpenBot is a free and open-source, self-hostable, local-first autonomous agent platform with a shared agent core, CLI, Ubuntu desktop app, web UI, API, and sandboxed workers. It should be a credible free/open-source alternative to Grok Bot: able to perform useful computer, browser, file, and research tasks while keeping deployment, data, model choice, provider credentials, permissions, and audit history under the operator's control.

OpenBot is not yet feature-equivalent to Grok Bot. The current implementation now has a bounded Ollama agent loop that can execute safe file, shell-diagnostic, and browser-fetch actions through the audited engine, while stopping for approval before consequential work. This PRD defines the path from that first real-work slice to a complete product.

## 2. Evidence and competitive context

Grok Bot is a managed cloud agent product. Its documentation describes persistent user Bots operating a managed Linux computer with browser, filesystem, terminal, shared sessions, routines, MCP/connectors, skills, and plugins. Model and infrastructure choices are product-managed. See [Grok Bot overview](https://docs.x.ai/grok-bot/overview), [skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations), and [plugins/marketplaces](https://docs.x.ai/build/features/skills-plugins-marketplaces).

Relevant open-source prior art includes [OpenHands](https://github.com/All-Hands-AI/OpenHands) for agent/runtime separation and sandboxes, [Open Interpreter](https://github.com/OpenInterpreter/open-interpreter) for local computer control, [OpenYak](https://github.com/openyak/openyak) for local desktop agents and MCP, [Somi](https://github.com/Somi-Project/Somi) for self-hosted skills and memory, [Goose](https://github.com/rorystandley/goose) for approvals and scheduling, and [OpenMake LLM](https://github.com/openmake/openmake_llm) for BYOK providers and Docker-isolated execution. These projects are references, not quality or security endorsements; licenses and maintenance must be reviewed before reuse.

Terminology: **local** means running on the same machine; **self-hostable** means the operator can deploy the complete stack on hardware or infrastructure they control. OpenBot is self-hostable and local-first, but can optionally use an operator-selected cloud model or remote worker. **Free** means no OpenBot license or hosted-account fee is required; users may still incur costs for optional third-party model APIs, hardware, electricity, storage, or hosting.

Open-source commitment: the core daemon, CLI, desktop app, workers, SDKs, and first-party extensions must be published under an OSI-approved license. Build, test, security, and packaging workflows must be reproducible from the public repository. Any bundled dependency, skill, model, or connector must have clearly documented licensing and attribution.

## 3. Problem statement

People want an agent that can complete multi-step work instead of only returning text, but cloud agents require trust in a vendor's computer, data handling, model routing, and permissions. Local tools provide privacy and control but commonly lack safe execution, resumable tasks, provider choice, a polished desktop experience, and a coherent extension system.

OpenBot should provide a practical middle path: real work through isolated workers, with local ownership by default and explicit opt-in to external providers or remote execution.

## 4. Target users

- **Ubuntu power user:** runs OpenBot on a workstation, uses CLI/SSH, and wants browser, files, and automation without surrendering control.
- **Developer/technical operator:** self-hosts OpenBot on a server or LAN, integrates APIs/MCP, and needs reproducible tasks and logs.
- **Privacy-sensitive professional:** needs local data, explicit approvals, and no hidden uploads.
- **Small team admin (future):** operates one private instance with users, policies, quotas, and shared skills.

## 5. Goals and non-goals

### Goals

1. A new operator can install and start the self-hosted core and use both CLI and desktop app in under 15 minutes with Ollama or a configured API provider.
2. OpenBot can complete at least three benchmark tasks end-to-end: a file task, a browser research task, and a shell task, each in an isolated workspace.
3. Every consequential action has a clear policy decision, approval record, actor, tool, arguments, result, and timestamp.
4. The operator can switch models/providers per agent or task without changing application code, while secrets remain outside prompts and logs.
5. A killed task can be inspected and resumed without losing its event history or workspace state.
6. A user can run the complete core product without an OpenBot account, license key, or mandatory hosted service.

### Non-goals for v1

- Building or training a foundation model.
- Claiming parity with Grok Bot's model quality or managed-cloud reliability.
- Unrestricted root-level desktop automation.
- A public plugin marketplace before signing, permissions, and review are defined.
- Multi-tenant SaaS billing, enterprise SSO, or hosted infrastructure.

## 6. Product principles

- **Self-hostable, local-first:** local inference and storage are the defaults; network access is visible and policy-controlled.
- **One core, many clients:** CLI, desktop, web, and API share task state and policy enforcement.
- **Least privilege:** workers receive only the workspace, tools, credentials, and network access required for a task.
- **Approval before impact:** sending, publishing, purchasing, deletion, credential use, and production changes require approval by default.
- **Never pretend:** the agent must distinguish planning, proposed actions, completed actions, and failed actions.
- **Provider-neutral:** Ollama first, then OpenAI-compatible endpoints and explicit adapters for other providers.
- **Recoverable by design:** pause, cancel, resume, replay, and rollback are first-class operations.

## 7. Current audit of the MVP

### Verified strengths

- Node server starts successfully on port 4178.
- JavaScript syntax checks pass for `server.mjs` and `public/app.js`.
- Ollama health endpoint reports six installed models on the audited machine.
- Chat request successfully returned a local model response.
- Approval decisions persist to `data/state.json`.
- Dashboard provides a coherent visual shell for health, approvals, routines, and chat.

### Material gaps and risks

- The local agent loop is bounded and structured, but it supports only the first-party file/shell/browser tool set and one task at a time.
- Approval records are attached to proposed actions and diffs, and the dashboard resumes the same task after an operator approves it.
- Routines are displayed but cannot be created, scheduled, executed, paused, or retried.
- No multi-user authorization, CSRF protection, or rate limiting exists; explicit non-loopback mode now requires a shared bearer token.
- Provider credentials, OAuth, model routing, MCP, plugins, routines, collaboration, and audit replay are absent or incomplete; local declarative skills are now supported.
- State uses an append-only JSONL event log with a lock and legacy migration path; retention, multi-process recovery policy, and encrypted-at-rest storage remain future work.
- The HTTP server is suitable for a local prototype only; it must not be exposed to a LAN or internet before hardening.
- CPU-only legacy mode is supported for core administration and allowlisted diagnostics; natural-language reasoning still depends on an installed local model and may be too slow for some older laptops.

### Current real-work slice

The first meaningful “bot, not control panel” milestone is implemented on the authoritative main baseline:

- `lib/agent.mjs` validates a strict JSON reply/action contract and runs at most six turns/actions in standard mode or three in `legacy` mode.
- `/api/chat`, `openbot chat`, and the dashboard use the same controller and existing policy/engine boundary.
- Safe reads/diagnostics execute automatically; writes, deletion, publishing, external communication, and other consequential effects stop with explicit approval.
- Model context, action results, approval details, and persisted audit events are redacted and bounded.
- The release harness covers 65 checks, including malformed model output, approval stop, low-resource execution, CLI/API flows, task history, memory, skills, UI safety, workspace containment, LAN authentication, and audit redaction.
- The dashboard shows recent durable tasks with audit links, and `doctor --json` explains the low-resource profile without requiring a model.
- Operators can save, list, and delete workspace-scoped local memory; only matching memory is injected into agent context after redaction.
- Operators can save, list, select, and delete local skills; selected skills are redacted, bounded, audited, and injected only as untrusted guidance under the OpenBot policy.

This is not a claim of Grok Bot parity. Grok Bot's managed cloud computer, persistent shared environment, connectors/MCP, routines, and collaboration remain OpenBot roadmap items; OpenBot currently provides scoped operator-controlled local memory plus explicit declarative local skills. OpenBot's differentiator is local ownership, zero mandatory spend, and inspectable policy/audit behavior.

## 8. User stories

### Ubuntu operator

- As an Ubuntu user, I want to install OpenBot from the CLI so that I can run it without a hosted account.
- As an operator, I want to open a desktop app connected to the same local daemon so that I can watch, approve, pause, and resume tasks.
- As an operator, I want a task to run in a disposable workspace so that an agent cannot modify unrelated files.
- As an operator, I want to see the exact command, URL, file diff, or message before approval so that I understand the impact.

### Developer/integrator

- As a developer, I want to add an MCP server with an allowlist so that agents can use controlled external tools.
- As a developer, I want to define a versioned skill with inputs, tools, tests, and permissions so that automations are reproducible.
- As an operator, I want to select Ollama or a BYOK provider per task so that cost, quality, and privacy are explicit.

### Privacy-sensitive user

- As a privacy-sensitive user, I want local-only mode to block external model and tool calls so that data cannot leave the host.
- As a user, I want secrets stored in an OS-backed vault and redacted from logs so that credentials are not exposed to models or other users.

## 9. Requirements

### P0 — required for the first real-work release

#### P0.1 Shared daemon and task model

Implement an `openbotd` service with durable task, event, workspace, approval, and worker records. CLI, desktop, web, and API clients must connect to this service.

Acceptance criteria:

- A task has stable ID, status, owner, provider, workspace, event sequence, and timestamps.
- Restarting the daemon does not lose completed events or active-task state.
- Concurrent clients see the same task status.

#### P0.2 CLI

Provide `start`, `run`, `list`, `show`, `approve`, `reject`, `pause`, `cancel`, `resume`, `logs`, `doctor`, and `config` commands.

Acceptance criteria:

- `openbot run` can submit a task and stream events.
- Approval and cancellation work without opening the desktop app.
- CLI returns non-zero exit codes for failed, rejected, or unavailable tasks.

#### P0.3 Ubuntu desktop app

Provide a Linux desktop app that connects to the daemon over a local authenticated channel.

Acceptance criteria:

- User can create, inspect, approve, pause, cancel, and resume tasks.
- UI shows live event stream, proposed actions, changed files, errors, and final result.
- Closing and reopening the app does not lose task history.

#### P0.4 Sandboxed execution workers

Implement separate workers for shell/files, browser, and (later in P0) desktop automation. Workers must be isolated per task using rootless containers or equivalent OS isolation.

Acceptance criteria:

- File and shell tasks cannot access paths outside an explicit workspace.
- Network access is deny-by-default and policy-controlled.
- A destructive command is blocked or approval-gated.
- Worker timeout, crash, and cleanup are observable and recoverable.

#### P0.5 Provider hub

Support Ollama and one OpenAI-compatible provider first; design an adapter interface for additional providers and OAuth-capable integrations.

Acceptance criteria:

- Provider keys are encrypted or stored in an OS secret store.
- Secrets never appear in prompts, event logs, error responses, or telemetry.
- Operator can choose provider/model per task.
- Local-only mode prevents all external provider calls.

#### P0.6 Approval and policy engine

Create policy rules by tool, path, domain, command class, credential, and risk level.

Acceptance criteria:

- Approval displays the exact proposed action and relevant diff/target.
- Approval is bound to one action and cannot be reused for another action.
- Rejected actions are not executed.
- Policy decisions and approvals are immutable audit events.

#### P0.7 Audit and recovery

Implement append-only event history with export and task replay metadata.

Acceptance criteria:

- Every model request, tool proposal, policy decision, approval, execution result, and error has an event.
- User can export a task audit bundle.
- A killed worker can be retried or resumed without silently repeating an approved consequential action.

### P1 — fast follow

- MCP server registry with signed/verified metadata, per-tool permissions, health checks, and disable/rollback.
- Versioned skills with manifests, permission declarations, fixtures, tests, and import/export.
- Plugin SDK with process isolation and capability permissions.
- Real scheduler with timezone, missed-run policy, retry policy, concurrency limits, and run history.
- Browser worker using Playwright/Browser Use with isolated profiles and domain policies.
- Desktop worker using explicit screen/input permissions and an emergency stop.
- Memory scoped by user, agent, task, and workspace with retention controls.
- Optional remote worker for a self-hosted private server while the desktop remains a client.

### P2 — future considerations

- Team workspaces, RBAC, SSO, quotas, and organization policies.
- Signed skill/plugin marketplace with review and revocation.
- Mobile companion and notifications.
- Multi-agent delegation and shared task graphs.
- Hosted OpenBot Cloud using the same self-hosted core.

### Free/open-source requirements

- No mandatory OpenBot SaaS account, telemetry, subscription, or license server.
- Local-only installation must remain fully functional with Ollama and open models.
- Optional provider integrations must be opt-in and clearly identify third-party costs.
- The repository must include source, build instructions, tests, container definitions, and release artifacts needed for self-hosting.
- No core feature may be intentionally disabled solely to force users toward a hosted OpenBot service.

## 10. Security and privacy requirements

- Bind the local daemon to loopback by default; require explicit configuration for LAN access.
- Authenticate every non-loopback client and rotate local tokens.
- Never run workers as root; use rootless containers or dedicated unprivileged accounts.
- Use workspace path allowlists and prevent symlink/path traversal escapes.
- Encrypt provider credentials at rest; redact tokens from logs and model context.
- Treat MCP servers, plugins, and skills as executable code with explicit capabilities.
- Add an emergency stop that terminates active workers.
- Add resource limits for CPU, memory, disk, process count, runtime, and network.
- Document that self-hosting transfers patching, backups, firewalling, and incident response responsibility to the operator.

## 11. Success metrics

### Launch gates

- 100% of benchmark tasks produce a complete event trail.
- 0 known workspace-escape findings in security testing.
- 0 secrets found in prompts, logs, exported audit bundles, or UI snapshots.
- At least 90% successful completion across the three P0 benchmark workflows on supported hardware.
- Resume-after-daemon-restart succeeds for at least 95% of non-final tasks.

### Product metrics

- Time from install to first successful local task: median under 15 minutes.
- Approval decision latency: median under 30 seconds for visible proposed actions.
- CLI and desktop clients report identical task status in 99% of integration-test cases.
- Local-only mode passes an automated outbound-network denial test.
- At least five repeatable skills are available in the initial reference catalog.

## 12. Benchmark tasks

1. **File task:** inspect a fixture repository, make a requested change, show a diff, and require approval before writing.
2. **Browser research:** visit an allowlisted set of sites, summarize findings, save Markdown locally, and cite URLs.
3. **Shell task:** run a safe diagnostic command in a sandbox, explain output, and refuse an unapproved destructive command.
4. **Provider switch:** complete the same task with Ollama and an OpenAI-compatible endpoint while preserving the same policy/audit behavior.
5. **Recovery:** kill the worker mid-task, restart the daemon, resume, and verify no duplicate external side effect.

## 13. Proposed architecture and dependencies

- **Core:** TypeScript daemon with a durable SQLite/Postgres event store and versioned task schema.
- **Execution:** rootless Docker/Podman or another isolated runtime; borrow proven runtime concepts from OpenHands rather than executing directly in the server process.
- **Browser:** Playwright-based worker; optionally integrate Browser Use MCP.
- **Models:** Ollama local API plus OpenAI-compatible adapter; provider interface must support streaming, tool calling, cancellation, and usage accounting.
- **Extensions:** MCP SDK, signed skill manifests, isolated plugin processes.
- **Clients:** CLI first, then Tauri desktop app, then web/API parity.
- **Packaging:** one-command installer for Ubuntu, systemd user service, health/doctor command, and documented upgrade/rollback.

## 14. Delivery phases

### Phase 0 — foundation

Replace JSON state with durable task/event storage, define policy and provider interfaces, add CLI skeleton, and lock down loopback/authentication.

### Phase 1 — first real work

Ship isolated file/shell worker, approvals, audit export, Ollama provider, and the three benchmark tasks.

### Phase 2 — usable clients

Ship desktop app connected to the same daemon, streaming events, recovery controls, and provider settings.

### Phase 3 — browser and extensibility

Add browser worker, MCP registry, skills, plugins, and scheduler.

### Phase 4 — hardening and differentiation

Add desktop worker, memory scopes, remote self-hosted workers, team policies, security review, and comparative benchmark reporting against Grok Bot and selected open-source alternatives.

## 15. Open questions

- **Engineering:** Tauri or Electron for the first desktop release?
- **Engineering:** Docker, Podman, or a dedicated sandbox runtime as the supported isolation boundary?
- **Security:** Which actions always require approval, even under a user-defined policy?
- **Product:** Is desktop automation P0 or P1 after shell/files/browser?
- **Product:** Which two cloud providers are required at launch besides Ollama?
- **Legal:** Which open-source projects or SDKs can be reused under their licenses?
- **Design:** Should the default experience be task-first chat, a terminal-first interface, or both equally?
- **Operations:** Does the project support only one local user initially, or authenticated LAN users?

## 16. Release decision

Do not market the current prototype as an autonomous Grok Bot alternative. Release it as an **OpenBot control-plane preview**. The first meaningful free/open-source alternative milestone is reached only when the CLI and desktop app can complete the benchmark tasks through isolated workers with approvals, recovery, and auditable evidence, using a no-account local installation.
