# OpenBot

OpenBot is a free, open-source, local-first bot that turns a task into bounded, auditable work on the operator's machine. It is the local/self-hosted alternative to the useful part of Grok Bot: a persistent task-oriented teammate that can use tools and stop for approval. OpenBot does not require an OpenBot account, paid service, GPU, or hosted agent.

## What works now

- Structured local agent loop over Ollama: a model returns either a final reply or one validated tool action at a time.
- Safe file reads/diffs, allowlisted shell diagnostics, and allowlisted loopback browser fetches through the existing policy/engine boundary.
- File writes and consequential shell work stop for one-shot, action-bound approval; the loop never auto-approves.
- Durable task/event history, redacted audit export, CLI parity, dashboard action cards, and task audit links.
- `legacy` resource profile for older CPU-only laptops: three turns/actions, compact context, and Docker-free allowlisted diagnostics.
- Loopback-only defaults, workspace containment, bounded requests, output/time limits, and security response headers.

## Run locally

```bash
npm run check
OPENBOT_RESOURCE_PROFILE=legacy node cli/openbot.mjs doctor --json
node cli/openbot.mjs chat --workspace /path/to/project "Read notes.txt and summarize it" --json
npm start
```

Natural-language tasks require a locally installed Ollama model. Core administration and bounded workers remain usable without a model. The legacy profile is a portability mode, not an unrestricted shell sandbox: only policy-allowlisted diagnostics may run directly on the host when Docker is unavailable.

## Product boundary

The current release is a real local bot loop, not Grok Bot parity. Desktop automation, MCP/connectors, plugins/skills, memory, scheduled routines, collaboration, multi-user auth, and remote workers remain future work. The server must not be exposed beyond loopback until authentication and authorization are implemented.

## Release verification

Run `npm run check` before publishing. The harness covers the agent contract, bounded loop, approval stop, low-resource mode, HTTP and CLI flows, workspace/path policy, browser/shell/file benchmarks, UI safety contracts, and audit redaction.
