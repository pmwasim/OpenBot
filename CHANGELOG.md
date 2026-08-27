# Changelog

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
