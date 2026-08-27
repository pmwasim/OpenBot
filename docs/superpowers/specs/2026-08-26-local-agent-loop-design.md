# Local Agent Loop Design

## Problem

OpenBot's authoritative `main` branch already has durable task state, policy decisions, approval-bound actions, and isolated FILE/SHELL/BROWSER workers. Its user-facing chat endpoint still performs one model conversation and returns prose; it never turns a user's request into a validated action proposal, executes safe work, feeds results back to the model, or presents a bounded multi-step outcome. The product therefore looks like an operations console instead of a bot that can do useful work.

## Goal

Connect natural-language chat to the existing audited execution core so a local Ollama-backed OpenBot can complete bounded file, shell, and browser tasks while preserving explicit approval for consequential actions, zero-cost local operation, and evidence-backed audit history.

The product target is the useful part of Grok Bot's concept—persistent named teammates that use tools, maintain task context, collaborate, and stop for approval—without requiring Grok Bot's managed cloud computer, paid seat, or hosted account. OpenBot must also run on older CPU-only laptops: the core cannot require Docker, a GPU, a native desktop shell, or large runtime dependencies.

## Non-goals for this iteration

- No unrestricted desktop input, credentials, MCP servers, plugins, routines, or remote workers.
- No claim that every laptop can run a large local model; legacy mode must run the core and bounded workers on CPU-only hardware and clearly report when a model is the limiting dependency.
- No automatic execution of deletion, publishing, purchasing, production changes, credential use, or external communication.
- No dependency on a live Ollama service for automated tests.
- No interpretation of arbitrary model prose as an executable command.
- No non-loopback exposure or authentication redesign in this iteration.

## User experience

1. The user enters a task and an explicit workspace path in the local console.
2. OpenBot creates a task and sends the prompt to the selected local model with a strict tool contract.
3. The model may return a final response or a bounded structured action proposal.
4. OpenBot validates the envelope, normalizes the tool, and sends the exact action through policy.
5. Safe read/diagnostic work executes automatically. File writes, shell mutations, browser saves, deletion, and other consequential work produce an approval with the exact arguments and diff/detail.
6. After an action executes, its redacted result is appended to the conversation and the model may request the next action, up to a small configured turn limit.
7. The UI shows the assistant response, proposed actions, approval state, execution result, and task/audit link. It never claims an action ran until the engine reports execution.

## Architecture

### Agent controller

Add a focused `lib/agent.mjs` controller. It owns the bounded conversation loop, strict response parsing, tool schema, turn/action limits, model request/response audit events, and calls the existing `createEngine` action boundary. It does not implement workers or policy. The controller accepts injected `chat` and `engine` dependencies so deterministic tests can exercise the loop without Ollama.

The accepted model envelope is JSON only:

```json
{
  "reply": "optional user-facing progress or final text",
  "action": {
    "tool": "file.read | file.diff | file.write | shell.exec | browser.fetch",
    "args": {}
  }
}
```

Exactly one of `reply` or `action` is required for each model turn. Unknown keys, unknown tools, malformed arguments, more than one action, or invalid JSON stop the loop with an explicit model-contract error and an audit event. The controller passes only the parsed action to the engine; model text is never executed.

### Provider adapter

Extend the Ollama adapter with a structured-chat option that accepts the tool contract in the system prompt and returns the raw assistant content for the controller to parse. Keep the existing ordinary chat behavior intact. The provider must not receive secrets from the event store or expose raw provider errors in audit output.

### HTTP boundary

Extend `POST /api/chat` with optional `workspace`, `model`, `maxTurns`, and `taskId` fields. It calls the controller and returns the task ID, final reply, action history, pending approvals, and terminal status. Invalid workspace, unavailable model, malformed model output, or turn-limit exhaustion return explicit status/error payloads while preserving the task event trail. Existing health, state, tasks, and direct action endpoints remain compatible.

### UI boundary

Add a workspace field and render structured action cards in the existing console. Cards distinguish proposed/approval-required/executed/denied/failed actions and link to the task audit endpoint. Keep DOM construction text-safe and use the existing approval endpoint. The UI may request the loop, but it must not bypass the server policy boundary.

### CLI boundary

Add `node cli/openbot.mjs chat --workspace <path> "..."` as a thin client around the same controller/API semantics, with JSON output for automation and a non-zero exit code for denied, failed, malformed, or incomplete runs.

## Safety and limits

- Default maximum model turns: 6; default maximum actions: 6.
- A loop with a pending approval stops and returns `waiting_approval`; it never polls or auto-approves.
- Every model request, model response metadata, action proposal, policy result, approval, execution result, and loop termination is an event tied to the task.
- Results are redacted before model context and API response where existing redaction applies.
- Workspace remains explicit; `local` is not silently converted to the repository or home directory.
- The server remains loopback-only by default.
- `OPENBOT_RESOURCE_PROFILE=legacy` selects low-resource defaults: 3 model turns, 3 actions, a compact context budget, and no Docker requirement for allowlisted diagnostics. The standard profile keeps the larger bounded defaults.
- When Docker is unavailable, the shell worker may run only the already policy-allowlisted diagnostic commands directly inside the explicit workspace; arbitrary commands, mutations, and destructive operations remain refused. This is a portability mode, not a general sandbox.

## Resource profiles

| Profile | Model turns/actions | Isolation | Intended host |
| --- | ---: | --- | --- |
| `legacy` | 3 / 3 | Docker optional; allowlisted diagnostics may use bounded cwd mode | Older CPU-only laptop |
| `standard` | 6 / 6 | Docker when available, otherwise explicit safe fallback | Modern local workstation |

Both profiles keep loopback-only binding, local storage, approval gates, workspace containment, and output/time limits. Ollama remains optional for core administration but is required for natural-language agent reasoning; the doctor command must distinguish a missing model from a broken installation.

## Testing and audit

- Add failing unit tests for strict envelope parsing, unknown-tool rejection, safe multi-turn execution, approval stop, malformed output, and turn-limit termination.
- Add harness integration coverage for `/api/chat` using an injected deterministic provider fixture or a test-only local adapter, plus workspace/file and shell evidence.
- Run the full release harness, extending the original 36 checks with agent-loop, CLI, API, UI-safety, low-resource, and audit-redaction checks.
- Run a product assessment against the three benchmark workflows and record remaining gaps in the PRD.
- Run the repository security scan and manually validate model-output handling, path containment, shell policy, redaction, loop bounds, and non-loopback refusal.
