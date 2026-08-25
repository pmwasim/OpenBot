# Ubuntu install

OpenBot runs without an OpenBot account, hosted service, subscription, or paid CI. The supported local path uses Node.js, the loopback daemon, and Ollama for local model inference.

For shell-worker execution, install Ubuntu's `bubblewrap` package and run OpenBot as an unprivileged user. If bubblewrap is absent, the production default fails closed with a clear worker error; do not switch to `OPENBOT_SANDBOX_MODE=allowlist` on a shared or untrusted machine.

## Install

From a checked-out OpenBot repository:

```bash
./scripts/install-ubuntu.sh
```

The installer copies the release into `~/.local/share/openbot` and creates a desktop launcher in `~/.local/share/applications`. It does not register a system service, change firewall rules, or upload data.

Start from the application menu or run:

```bash
node ~/.local/share/openbot/desktop/openbot.mjs
```

For a headless or SSH session, use `--no-open` and visit the printed loopback URL from the same machine.

## Local model

Install Ollama separately, start it, and download a model appropriate for the machine. OpenBot remains usable for task creation, approvals, workers, audit export, and CLI administration when Ollama is offline; chat/model planning is unavailable until Ollama is ready.

## Configuration

Copy [.env.example](../.env.example) into your shell environment or configure the variables in the launch environment. OpenBot binds to loopback by default. `OPENBOT_ALLOW_NON_LOOPBACK=1` is an explicit unsafe override, not authentication, and must not be used on an untrusted network.

Browser access is disabled in local-only mode. To enable it, set `OPENBOT_LOCAL_ONLY=0` and provide an explicit `OPENBOT_BROWSER_ALLOWLIST`; private, loopback, metadata, credential-bearing, and non-HTTP targets remain blocked.

## Removal

```bash
./scripts/uninstall-ubuntu.sh
```

The removal helper moves the install and launcher aside with a timestamp so recovery is possible. It does not remove task data automatically.
