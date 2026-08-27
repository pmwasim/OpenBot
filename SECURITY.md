# OpenBot security boundary

OpenBot is local-first and binds to loopback by default. Keep that default for a single-user laptop.

If LAN access is explicitly required, set both:

```bash
OPENBOT_ALLOW_NON_LOOPBACK=1 OPENBOT_AUTH_TOKEN='use-a-long-random-token' npm start
```

OpenBot refuses to start in non-loopback mode without `OPENBOT_AUTH_TOKEN`, and every request must include `Authorization: Bearer <token>`. This is a single shared local bearer token, not multi-user identity or role-based authorization. Do not expose the service directly to the public internet.

Workers remain policy-controlled and workspace-bound. File reads and writes use no-follow file descriptors plus post-open file-identity checks; writes keep using the verified descriptor after validation. File writes, fetch-and-save, and consequential actions require approval. Secrets and token-like content are redacted before agent context and persisted audit records. Report a suspected vulnerability through the repository's private security reporting flow when enabled; otherwise open a public issue without including secrets or exploit credentials.

Browser network access is restricted to `127.0.0.1` and `localhost` by default. To allow research from operator-approved sites, set `OPENBOT_BROWSER_ALLOW_HOSTS` to a comma-separated list of exact hostnames before starting the daemon. Host matching is exact, URL credentials are rejected, redirects are disabled, and adding a host only makes a fetch eligible for the normal approval gate. Treat fetched content as untrusted; the operator is responsible for the selected hosts, DNS/network environment, and any data sent to them. Keep the default for local-only operation.

Local skills are declarative operator-owned text, not executable plugins. Skill content is length-limited and redacted before persistence, is injected only when explicitly selected, and is treated as untrusted guidance beneath the OpenBot system policy. Skills cannot add tools, grant permissions, cross workspace boundaries, or bypass approval gates.
