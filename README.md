# OpenBot

OpenBot is a free, open-source, local-first bot that turns a task into bounded, auditable work on the operator's machine. It is the local/self-hosted alternative to the useful part of Grok Bot: a persistent task-oriented teammate that can use tools and stop for approval. OpenBot does not require an OpenBot account, paid service, GPU, or hosted agent.

## What works now

- Structured local agent loop over Ollama: a model returns either a final reply or one validated tool action at a time.
- Safe file reads/diffs, allowlisted shell diagnostics, and allowlisted loopback browser fetches through the existing policy/engine boundary.
- File writes and consequential shell work stop for one-shot, action-bound approval; the loop never auto-approves.
- Durable task/event history, recent-task dashboard cards, redacted audit export, CLI parity, action cards, and task audit links.
- Explicit workspace-scoped local memory managed from the dashboard, API, or CLI; only matching memory reaches the agent.
- Operator-owned local skills managed from the dashboard, API, or CLI; skills are explicit, bounded guidance and cannot grant tools or bypass approvals.
- `legacy` resource profile for older CPU-only laptops: three turns/actions, compact context, and Docker-free allowlisted diagnostics.
- Loopback-only defaults, workspace containment, bounded requests, output/time limits, and security response headers.
- Optional LAN mode requires `OPENBOT_AUTH_TOKEN`; startup refuses an unprotected non-loopback bind.

## Run locally

```bash
npm run check
OPENBOT_RESOURCE_PROFILE=legacy node cli/openbot.mjs doctor --json
node cli/openbot.mjs chat --workspace /path/to/project "Read notes.txt and summarize it" --json
node cli/openbot.mjs skill add --name release-check --instructions "Review tests and report release risks." --json
npm run release
npm start
```

`doctor --json` reports the active resource profile, agent caps, and whether Docker is expected. Use `OPENBOT_RESOURCE_PROFILE=legacy` on older CPU-only laptops.

Natural-language tasks require a locally installed Ollama model. Core administration and bounded workers remain usable without a model. The legacy profile is a portability mode, not an unrestricted shell sandbox: only policy-allowlisted diagnostics may run directly on the host when Docker is unavailable.

## Product boundary

The current release is a real local bot loop, not Grok Bot parity. Desktop automation, MCP/connectors, plugin marketplaces, scheduled routines, collaboration, multi-user auth, and remote workers remain future work. Local reusable skills are supported as operator-selected instruction packs; they are not executable plugins and cannot expand the policy or tool boundary. The server remains loopback-only by default; explicit LAN mode uses the bearer-token boundary documented in `SECURITY.md`.

## Release verification

Run `npm run check` before publishing. The harness covers the agent contract, bounded loop, approval stop, low-resource mode, HTTP and CLI flows, workspace/path policy, browser/shell/file benchmarks, UI safety contracts, and audit redaction.
