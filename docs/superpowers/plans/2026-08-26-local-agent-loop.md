# Local Agent Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn OpenBot chat into a bounded local agent that proposes and executes policy-controlled FILE/SHELL/BROWSER work with approvals and audit evidence.

**Architecture:** Add a small `lib/agent.mjs` controller that parses a strict JSON model envelope and delegates every action to the existing engine. Extend the HTTP, CLI, and console surfaces to invoke and display that controller while preserving existing direct action APIs and local-only defaults.

**Tech Stack:** Node.js ESM, built-in `node:test`-compatible harness style, Node HTTP server, Ollama HTTP API, existing append-only JSONL store, existing workers and policy engine, vanilla browser JavaScript.

**Spec:** `docs/superpowers/specs/2026-08-26-local-agent-loop-design.md`

## Global Constraints

- Zero budget: do not add paid services, hosted agents, mandatory accounts, or runtime dependencies.
- Model prose is never executable; only strict parsed structured actions reach the engine.
- Preserve loopback-only defaults, explicit workspace paths, existing policy decisions, redaction, and approval binding.
- Maximum default agent loop is 6 turns and 6 actions; pending approval terminates the loop.
- `OPENBOT_RESOURCE_PROFILE=legacy` must run the core on CPU-only older laptops with 3 turns/actions, compact context, and no Docker requirement for allowlisted diagnostics.
- Do not add a runtime dependency that is not already available in a stock Node.js LTS installation.
- Existing `/api/chat`, direct `/api/actions`, CLI, worker, and harness behavior must remain compatible unless covered by new tests.

---

### Task 1: Add strict agent controller contract

**Files:**
- Create: `lib/agent.mjs`
- Modify: `lib/provider.mjs`
- Test: `scripts/release_harness.mjs`

**Interfaces:**
- `parseAgentEnvelope(text)` returns `{ reply, action }` or throws a 400-style contract error; exactly one of `reply` or `action` is present.
- `createAgentController({ store, provider, engine, actor, maxTurns, maxActions })` returns `run({ taskId, prompt, workspace, model })`.
- `provider.chatStructured({ model, messages, tools })` returns `{ ok, reply, error, status, model }`.

- [ ] **Step 1: Write failing harness assertions** for valid final replies, valid actions, unknown tools, malformed JSON, safe multi-turn execution, pending approval stop, and turn-limit stop. Use a deterministic fake provider and a real temporary workspace/engine.
- [ ] **Step 2: Run `npm run check`** and verify the new assertions fail because `lib/agent.mjs` and `chatStructured` do not exist.
- [ ] **Step 3: Implement the minimal parser and controller** with strict keys, normalized tool arguments, model/audit events, bounded turns/actions, and engine delegation. Do not add worker logic.
- [ ] **Step 4: Implement Ollama `chatStructured`** as a compatibility wrapper around `/api/chat` that includes the JSON contract in the system message and returns raw assistant content without exposing secrets.
- [ ] **Step 5: Add resource-profile assertions** for legacy defaults and bounded context/action limits before wiring them into the server.
- [ ] **Step 6: Run `npm run check`** and verify all controller and legacy-profile assertions pass.
- [ ] **Step 7: Commit** `feat: connect chat to bounded local agent loop`.

### Task 2: Expose the agent loop through the HTTP API

**Files:**
- Modify: `server.mjs`
- Modify: `lib/config.mjs`
- Test: `scripts/release_harness.mjs`

**Interfaces:**
- `POST /api/chat` accepts `{ message, workspace, model?, taskId?, maxTurns? }` and returns `{ taskId, status, reply, actions, approvals }`.
- `OPENBOT_AGENT_MAX_TURNS` configures the bounded default; invalid values fall back to the safe default.

- [ ] **Step 1: Add failing HTTP assertions** using the deterministic provider injection path: a safe file read reaches execution, a file write stops at approval, malformed model output returns a contract failure, and absent workspace is rejected.
- [ ] **Step 2: Run `npm run check`** and verify the API assertions fail because chat still performs prose-only planning.
- [ ] **Step 3: Wire server chat to the controller** while retaining model availability and installed-model checks; create/reuse the task with explicit workspace and record terminal task status.
- [ ] **Step 4: Add safe test injection** through a non-production function parameter or test-only local provider fixture, without adding an environment secret or bypassing policy in production.
- [ ] **Step 5: Wire legacy profile limits and explicit resource metadata** into the API health/config surfaces.
- [ ] **Step 6: Run `npm run check`** and verify API assertions pass with no regression in health, state, direct actions, or loopback checks.
- [ ] **Step 7: Commit** `feat: expose bounded agent chat api`.

### Task 3: Add CLI parity

**Files:**
- Modify: `cli/openbot.mjs`
- Test: `scripts/release_harness.mjs`
- Modify: `README.md`

**Interfaces:**
- `node cli/openbot.mjs chat --workspace <path> [--model <name>] [--json] "prompt"` invokes the same local agent semantics.
- Exit code is non-zero for missing workspace, model contract failure, denied action, failed action, or pending approval.

- [ ] **Step 1: Add failing CLI assertions** for a successful deterministic file-read conversation, a pending file-write approval, and malformed model output.
- [ ] **Step 2: Run `npm run check`** and verify the command is missing or returns the expected failure.
- [ ] **Step 3: Implement `chat`** as a thin local invocation using shared controller code, with redacted JSON and concise human output.
- [ ] **Step 4: Document the real-bot workflow** and explicit workspace/approval behavior in the README.
- [ ] **Step 5: Run `npm run check`** and verify CLI parity plus all previous checks.
- [ ] **Step 6: Commit** `feat: add local agent chat cli`.

### Task 4: Turn the console into a real task surface

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Test: `scripts/release_harness.mjs`

**Interfaces:**
- The form submits `{ message, workspace, model? }` to `/api/chat`.
- The response renders final text and action cards with statuses: proposed, waiting approval, executed, denied, failed.

- [ ] **Step 1: Add a static/UI contract assertion** that the workspace field, action status classes, audit link, and no unsafe `innerHTML` interpolation for model text are present.
- [ ] **Step 2: Run `npm run check`** and verify the assertion fails against the current one-field prose-only form.
- [ ] **Step 3: Implement the workspace field and safe DOM rendering** using `textContent`, escaped attributes, and task audit links.
- [ ] **Step 4: Keep approval actions on the existing `/api/approval` endpoint** and refresh the state after decisions.
- [ ] **Step 5: Run `npm run check`**, then perform a manual browser smoke test against a deterministic local task fixture.
- [ ] **Step 6: Commit** `feat: make the console a real agent workspace`.

### Task 5: Product assessment and security/audit gate

**Files:**
- Modify: `PRD.md`
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Create: `docs/audits/2026-08-26-local-agent-loop-assessment.md`

- [ ] **Step 1: Run `npm run check`** and capture the complete pass count and benchmark evidence.
- [ ] **Step 2: Run the repository security-scan workflow** against this worktree and retain the generated report/coverage artifacts.
- [ ] **Step 3: Manually inspect findings** against the model parser, policy boundary, workspace containment, redaction, loop limits, and loopback binding; fix any validated finding test-first.
- [ ] **Step 4: Execute product benchmarks** for FILE, SHELL, and BROWSER using deterministic fixtures, recording what is actually automated and what still requires Ollama.
- [ ] **Step 5: Run the legacy profile on a Docker-unavailable simulation** and prove allowlisted diagnostics work while arbitrary shell commands remain refused.
- [ ] **Step 6: Update PRD, changelog, and assessment** with achieved behavior, known gaps, Grok Bot concept comparison, and exact verification commands.
- [ ] **Step 7: Run final syntax, harness, and git status checks** and commit `docs: assess local agent loop release gate`.

### Task 6: Repeat from verified gap

- [ ] **Step 1: Re-read the current PRD gap list and assessment** after Task 5.
- [ ] **Step 2: Select the next highest-value missing user capability** that can be implemented without violating the zero-cost/security boundary.
- [ ] **Step 3: Write a new failing test and repeat the red-green-audit cycle** in a follow-up iteration; do not claim the overall product is complete merely because this plan passes.
