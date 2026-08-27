# OpenBot

OpenBot is a free, open-source, local-first bot that turns a task into bounded, auditable work on the operator's machine. It is a self-hosted task-oriented teammate that can use tools and stop for approval. OpenBot does not require an account, paid service, GPU, or hosted agent.

## What works now

- Structured local agent loop: a local model returns either a final reply or one validated tool action at a time.
- Safe file reads/diffs, allowlisted shell diagnostics, and allowlisted loopback browser fetches through the existing policy/engine boundary; fetch-and-save requires approval.
- File writes and consequential shell work stop for one-shot, action-bound approval; the loop never auto-approves.
- Durable task/event history, recent-task dashboard cards, redacted audit export, CLI parity, action cards, and task audit links.
- Interrupted tasks can be resumed from the CLI, API, or dashboard after the daemon is reopened, retaining the same task identity and event history.
- Explicit workspace-scoped local memory managed from the dashboard, API, or CLI; only matching memory reaches the agent.
- Operator-owned local skills managed from the dashboard, API, or CLI; skills are explicit, bounded guidance and cannot grant tools or bypass approvals.
- Durable named local bots with a role, instructions, workspace, optional skill, and bounded conversation history managed from the dashboard, API, or CLI.
- Local routines managed from the dashboard, API, or CLI; schedules are explicit, runs are durable, and Run now uses the same approval-safe agent loop.
- `legacy` resource profile for older CPU-only laptops: three turns/actions, compact context, and container-free allowlisted diagnostics.
- Loopback-only defaults, workspace containment, bounded requests, output/time limits, and security response headers.
- Optional LAN mode requires `OPENBOT_AUTH_TOKEN`; startup refuses an unprotected non-loopback bind.

## Run locally

```bash
npm run check
OPENBOT_RESOURCE_PROFILE=legacy node cli/openbot.mjs doctor --json
node cli/openbot.mjs chat --workspace /path/to/project "Read notes.txt and summarize it" --json
node cli/openbot.mjs bot add --name "Release steward" --role "Review local releases" --instructions "Check tests and report risks." --workspace /path/to/project --json
node cli/openbot.mjs bot list --json
node cli/openbot.mjs resume <task-id> --json
node cli/openbot.mjs skill add --name release-check --instructions "Review tests and report release risks." --json
node cli/openbot.mjs routine add --title "Workspace review" --schedule "daily 09:30" --workspace /path/to/project "Review the workspace and report risks." --json
npm run release
npm start
```

`doctor --json` reports the active resource profile, agent caps, and whether container isolation is expected. Use `OPENBOT_RESOURCE_PROFILE=legacy` on older CPU-only laptops.

Natural-language tasks require a locally installed model runtime. Core administration and bounded workers remain usable without a model. The legacy profile is a portability mode, not an unrestricted shell sandbox: only policy-allowlisted diagnostics may run directly on the host when container isolation is unavailable.

## Product boundary

The current release is a real local bot loop with durable named bots, reusable local skills, and explicit local routines. Desktop automation, connectors, signed extensions, collaboration, multi-user auth, and remote workers remain future work. Local reusable skills are supported as operator-selected instruction packs; they are not executable extensions and cannot expand the policy or tool boundary. The server remains loopback-only by default; explicit LAN mode uses the bearer-token boundary documented in `SECURITY.md`. The scheduler runs while the local daemon is running; it does not install a background service.

## Release verification

Run `npm run check` before publishing. The harness covers the agent contract, bounded loop, approval stop, low-resource mode, HTTP and CLI flows, workspace/path policy, browser/shell/file benchmarks, UI safety contracts, and audit redaction.
