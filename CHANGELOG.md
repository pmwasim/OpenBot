# Changelog

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

- Added a strict Ollama agent loop with validated structured actions.
- Added safe file reads/diffs, allowlisted shell diagnostics, and loopback browser fetches.
- Added one-shot approval gates and same-task resume after approval.
- Added CLI `chat`, dashboard workspace/action/audit UX, and fresh-state initialization without synthetic work.
- Added `legacy` CPU-only resource profile and Docker-free fixed-path diagnostics.
- Hardened persisted audit redaction for sensitive fields, token-like content, diffs, and action results.
- Added 49 release-harness checks covering product behavior, security boundaries, and portability.

This release remains loopback-only by default. Desktop automation, MCP/connectors, plugins/skills, memory, routines, collaboration, multi-user auth, and remote workers are roadmap work. Natural-language reasoning requires an installed local Ollama model; no OpenBot account or paid service is required.
