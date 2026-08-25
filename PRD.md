# OpenBot Product Requirements Document

**Status:** Implementation baseline for v0.2 release candidate
**Version:** 0.2
**Date:** 2026-08-26
**Owner:** OpenBot product/engineering

## 1. Executive summary

OpenBot is a free and open-source, self-hostable, local-first autonomous agent platform with a shared agent core, CLI, Ubuntu launcher, web UI, API, and bounded workers. It is being shipped as the first real-work release candidate for a credible free/open-source alternative to Grok Bot: useful local file and shell tasks, controlled browser fetches, explicit approvals, and auditable recovery while keeping deployment, data, model choice, provider credentials, permissions, and history under the operator's control.

OpenBot is not yet better than Grok Bot. The current MVP provides an Ollama-backed chat endpoint, health checks, a local dashboard, and persisted approval/routine state, but it does not execute shell, browser, desktop, or file work. This PRD defines the smallest credible path from that prototype to a real product.

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

- The daemon persists an append-only event log with migration and atomic replacement, reconstructing task and approval projections after reopen.
- File, shell, and browser workers enforce task-workspace, allowlist, timeout, output, and local/private-network boundaries; Linux shell execution can fail closed unless bubblewrap is present.
- The executor proves one-time approval consumption, duplicate-start refusal, pause/cancel/resume transitions, and recoverable shutdown state.
- The API and responsive operator console expose task creation, approvals, events, SSE, health, and redacted audit export; the CLI covers the same local operator path.
- Ollama is the default provider and an OpenAI-compatible adapter is optional and blocked in local-only mode.

### Material gaps and risks

- `/api/chat` remains a model conversation endpoint; structured execution is intentionally submitted through task actions so free-form model text cannot become a command.
- The Ubuntu desktop surface is a local launcher around the audited web console, not a separate native Tauri/Electron application.
- Routines are displayed but cannot be created, scheduled, executed, paused, or retried.
- No authentication, authorization, CSRF protection, rate limiting, or multi-user boundary exists; the daemon must remain loopback-only unless an operator adds a trusted fronting boundary.
- MCP, skills, plugins, memory, scheduler, desktop input automation, and audit replay are future work.
- The worker model is a bounded first release, not unrestricted OS control or managed-cloud reliability.

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

Release v0.2 as an **OpenBot first real-work release candidate**, with the documented loopback, authentication, native desktop, routines, and extension limitations. Do not claim managed-cloud parity with Grok Bot. The next production-hardening gate is authenticated non-loopback access plus a native desktop client and benchmark evidence on a clean Ubuntu host with bubblewrap isolation.
