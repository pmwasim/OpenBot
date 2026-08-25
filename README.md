# OpenBot

OpenBot is a free and open-source, self-hostable, local-first control-plane preview inspired by cloud agent teammates. It supplies a private control dashboard, an Ollama-backed task conversation, approval gates, a durable task/event store, a CLI skeleton, persisted approvals, and a repeatable release harness.

## What it does now

- Detects whether Ollama is running and lists installed local models.
- Sends planning tasks to the first available Ollama model.
- Keeps a local approval queue; sending, publishing, purchases, deletion, and production changes should remain approval-gated.
- Presents the architectural seams needed for browser and desktop workers, while deliberately leaving those disabled until they can be isolated and permissioned.
- Uses safe local defaults: loopback binding, bounded JSON requests, model allowlisting, atomic event-log writes, and security response headers.

## Release checks

Run the production baseline harness before publishing a release:

```bash
npm run check
```

The harness starts an isolated test server and verifies required files, health/state endpoints, model validation, request-size limits, and path traversal rejection. It does not claim that browser, shell, or desktop workers exist; those remain planned product work in [PRD.md](./PRD.md).

## Run

1. Install and start Ollama, then download a small local model such as a Qwen 7–8B quantized model.
2. In this folder, run `npm start`.
3. Open `http://127.0.0.1:4178`.

The server binds to loopback by default. The daemon refuses a non-loopback HOST unless OPENBOT_ALLOW_NON_LOOPBACK=1 is set; the preview still has no authentication and must not be exposed to the public internet. CLI: node cli/openbot.mjs doctor|run|list|show|approve|reject|pause|cancel|resume|logs|config.

OpenBot contains no automatic shell, browser, or desktop execution in this first version. That separation is intentional: a real worker should be isolated from the primary desktop and require explicit approval rules.
