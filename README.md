# OpenBot

OpenBot is a free and open-source, self-hostable, local-first control-plane preview inspired by cloud agent teammates. It supplies a private control dashboard, an Ollama-backed task conversation, approval gates, a durable task/event store, a CLI skeleton, persisted one-shot approvals, isolated file/shell/browser workers, and a repeatable release harness.

## What it does now

- Detects whether Ollama is running and lists installed local models.
- Sends planning tasks to the first available Ollama model. The dashboard chat still plans only and does not execute tools.
- Keeps a local approval queue; sending, publishing, purchases, deletion, production changes, and workspace file writes require approval. Approvals bind to one action digest and cannot be reused.
- Isolated file, shell, and browser workers are used by the engine and the release harness.
- File worker: workspace-bound writes show a diff and require one-shot approval.
- Shell worker: Docker alpine sandbox, network disabled; safe diagnostics allowed.
- Browser worker: allowlisted loopback fetch, Markdown saved with a cited URL.
- Desktop automation remains disabled until it can be isolated and permissioned.
- Uses safe local defaults: loopback binding, bounded JSON requests, model allowlisting, atomic event-log writes, and security response headers.
- Records actor, tool, args, result, and timestamp on every consequential action event.

## Release checks

Run the production baseline harness before publishing a release:
See package.json scripts.check for the release harness.
