# OpenBot

OpenBot is a free, open-source, self-hostable alternative to cloud agent products. It is local-first: the daemon, task history, approvals, workspaces, and audit bundles stay on the operator's machine by default, with Ollama as the local model path.

## Included in this release foundation

- Durable append-only task/event storage with legacy migration and atomic writes.
- Action-bound policy decisions and one-time approvals for file writes/deletes, shell execution, browser fetches, and consequential task kinds.
- Bounded file, shell, and browser workers with task-workspace containment, symlink escape checks, output/time limits, and private-network refusal.
- Recoverable executor lifecycle with pause, cancel, resume, duplicate-start protection, and shutdown recovery.
- Local HTTP API, SSE task streams, redacted audit export, and a responsive operator console.
- CLI parity for task creation, approval, execution, recovery, logs, inspection, export, configuration, and health checks.
- Ubuntu user installer and desktop launcher. No OpenBot account, hosted service, subscription, or paid CI is required.

## Zero-spend local run

```bash
npm run check
npm start
```

Open `http://127.0.0.1:4178`. Install Ollama separately if you want local model chat and planning; task control, approvals, workers, audit export, and CLI administration do not require a hosted OpenBot service.

For Ubuntu desktop installation:

```bash
./scripts/install-ubuntu.sh
```

See [docs/ubuntu.md](docs/ubuntu.md) for the local model and configuration path. Copy [.env.example](.env.example) to your shell environment; never commit provider keys.

## CLI

```bash
node cli/openbot.mjs doctor
node cli/openbot.mjs run --kind plan "Prepare a release checklist"
node cli/openbot.mjs run --kind file --action-json '{"tool":"file.write","path":"notes.txt","content":"draft"}' "Write a local note"
node cli/openbot.mjs list
node cli/openbot.mjs show <task-id>
node cli/openbot.mjs approve <approval-id>
node cli/openbot.mjs pause <task-id>
node cli/openbot.mjs resume <task-id>
node cli/openbot.mjs export <task-id>
```

The structured action is the exact payload evaluated by policy and, after approval, sent to the worker. Free-form chat text is never treated as a command. CLI output is redacted for secret-shaped fields.

## Safety boundary

OpenBot binds to loopback by default. Setting `OPENBOT_ALLOW_NON_LOOPBACK=1` is an explicit unsafe override, not authentication, and must not be used on an untrusted network. Local-only mode blocks the browser worker and non-local providers. Browser fetches require an explicit host allowlist and reject credentials, loopback, private, and cloud-metadata targets.

On Linux, shell workers require rootless `bubblewrap` isolation by default and run with the task workspace mounted at `/workspace` and no network namespace. On non-Linux development hosts, the default is the bounded allowlist mode; set `OPENBOT_SANDBOX_MODE=required` to fail closed instead. Production operators should run the daemon as an unprivileged user and apply the host-level resource controls documented in [PRD.md](PRD.md). The repository deliberately does not claim unrestricted desktop automation or managed-cloud parity with Grok Bot.

## Verification and release

```bash
npm run check
npm run release
```

The harness covers persistence, approval binding, worker boundaries, executor recovery, CLI parity, API/SSE execution, redacted export, request limits, traversal rejection, and loopback binding. A GitHub Release is publication, not a substitute for these checks.

See [CHANGELOG.md](CHANGELOG.md), [docs/release-design.md](docs/release-design.md), and [PRD.md](PRD.md) for the implementation boundary and remaining product gates.
