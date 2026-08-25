# OpenBot

OpenBot is a local-first MVP inspired by cloud agent teammates. It supplies a private control dashboard, an Ollama-backed task conversation, approval gates, and persisted routine/approval state.

## What it does now

- Detects whether Ollama is running and lists installed local models.
- Sends planning tasks to the first available Ollama model.
- Keeps a local approval queue; sending, publishing, purchases, deletion, and production changes should remain approval-gated.
- Presents the architectural seams needed for browser and desktop workers, while deliberately leaving those disabled until they can be isolated and permissioned.

## Run

1. Install and start Ollama, then download a small local model such as a Qwen 7–8B quantized model.
2. In this folder, run `npm start`.
3. Open `http://127.0.0.1:4178`.

OpenBot contains no automatic shell, browser, or desktop execution in this first version. That separation is intentional: a real worker should be isolated from the primary desktop and require explicit approval rules.
