# OpenBot security boundary

OpenBot is local-first and binds to loopback by default. Keep that default for a single-user laptop.

If LAN access is explicitly required, set both:

```bash
OPENBOT_ALLOW_NON_LOOPBACK=1 OPENBOT_AUTH_TOKEN='use-a-long-random-token' npm start
```

OpenBot refuses to start in non-loopback mode without `OPENBOT_AUTH_TOKEN`, and every request must include `Authorization: Bearer <token>`. This is a single shared local bearer token, not multi-user identity or role-based authorization. Do not expose the service directly to the public internet.

Workers remain policy-controlled and workspace-bound. File reads and writes use no-follow file descriptors plus post-open file-identity checks; writes keep using the verified descriptor after validation. File writes, fetch-and-save, and consequential actions require approval. Secrets and token-like content are redacted before agent context and persisted audit records. Report a suspected vulnerability through the repository's private security reporting flow when enabled; otherwise open a public issue without including secrets or exploit credentials.

Browser network access is restricted to `127.0.0.1` and `localhost` by default. To allow research from operator-approved sites, set `OPENBOT_BROWSER_ALLOW_HOSTS` to a comma-separated list of exact hostnames before starting the daemon. Host matching is exact, URL credentials are rejected, redirects are disabled, and adding a host only makes a fetch eligible for the normal approval gate. Treat fetched content as untrusted; the operator is responsible for the selected hosts, DNS/network environment, and any data sent to them. Keep the default for local-only operation.

Local connectors are read-only operator-owned HTTP definitions. Each connector rejects URL credentials, queries, fragments, unsupported protocols, malformed or traversal paths, and duplicate names. A request must use an enabled connector, an explicitly registered absolute path, and a host present in the same exact allowlist used for browser network access. The worker issues only `GET`, disables redirects, caps the response at 64 KiB, and applies a 10-second timeout. Every `connector.fetch` request is approval-gated; the action digest includes the connector id, endpoint, enabled state, and path allowlist, so changing a connector invalidates an earlier approval. Connector responses are treated as untrusted input and are redacted before durable audit delivery. Connectors do not store or attach authentication credentials.

Local skills are declarative operator-owned text, not executable plugins. Skill content is length-limited and redacted before persistence, is injected only when explicitly selected, and is treated as untrusted guidance beneath the OpenBot system policy. Skills cannot add tools, grant permissions, cross workspace boundaries, or bypass approval gates.

Named-bot conversation search accepts only a bounded text query, filters the bot's already bounded message history, and returns the same redacted message fields as ordinary history. It does not search other bots, task events, or workspace files.

Failed-task retry is limited to terminally failed tasks and three attempts. It creates a durable `task.retry` event, clears only the prior task outcome, and does not carry forward a consumed approval; consequential actions therefore return to the normal fresh approval boundary on retry.

Resource selection is local configuration only. `OPENBOT_RESOURCE_PROFILE=auto` chooses the bounded `legacy` profile at 2 or fewer logical CPUs or below 8 GiB RAM; otherwise it chooses `standard`. The selected profile changes agent turn/action/context limits and defaults isolation to host-local mode for the low-resource profile. Operators can explicitly set `legacy`, `standard`, or `OPENBOT_ISOLATION`; this setting does not install software, contact a remote service, or guarantee local-model performance.

Task admission is bounded as a resource-safety control. Legacy permits one active task and four waiting tasks; standard permits two active tasks and eight waiting tasks. `OPENBOT_MAX_CONCURRENT_TASKS` and `OPENBOT_MAX_QUEUED_TASKS` are capped configuration overrides. A full queue is rejected with HTTP 429 and does not create an unbounded in-memory backlog. Queueing limits resource pressure but is not a sandbox or a guarantee that a local model will respond quickly.

Queued admission is also recorded durably. After a daemon restart, only pending tasks whose latest queue event is `task.queued` are automatically recovered; tasks that reached `task.admitted` are not automatically replayed, so an already-running consequential action cannot be silently repeated. Recovery remains bounded by the configured queue capacity.
