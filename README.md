# pi-deepinfra

A [pi](https://github.com/earendil-works/pi) extension that adds the **DeepInfra**
provider: 90+ hosted chat models (DeepSeek, Qwen, Llama, Gemma, Mistral, plus hosted
frontier models like Claude and Gemini), with dynamic model discovery, reasoning-effort
control, vision, and a footer statusline showing session token usage + cost and
DeepInfra monthly usage.

## Install

Requires [pi](https://github.com/earendil-works/pi).

- **npm** (recommended):

  ```bash
  pi install npm:pi-deepinfra
  ```

- **git** (latest source):

  ```bash
  pi install git:github.com/puetsua/pi-deepinfra
  ```

1. Authenticate — either:

   - **Interactive**: inside pi, run `/login deepinfra` and paste your API key
     (from https://deepinfra.com/dash/api_keys). The key is stored in
     `~/.pi/agent/auth.json`.
   - **Environment**: set `DEEPINFRA_API_KEY` in your shell.

   If a `deepinfra` `api_key` entry already exists in `~/.pi/agent/auth.json`,
   it is picked up automatically.

2. Restart pi (or `/reload`), then select a model:

   ```
   /model deepinfra/deepseek-ai/DeepSeek-V4-Flash-0731
   ```

## What you get

| Feature | Notes |
|---|---|
| **Model catalog** | Fetched live from `https://api.deepinfra.com/v1/openai/models` at startup — no manual model list to maintain. All `chat`-tagged models are registered (embeddings/image/TTS/STT excluded). Falls back to a curated list if the catalog is unreachable. |
| **Streaming** | `openai-completions` API; SSE streaming with `reasoning_content` thinking deltas on reasoning models. |
| **Thinking levels** | `reasoning_effort` maps 1:1 to pi thinking levels (`minimal`…`max`); `off` → `none`. E.g. `Ctrl+P` or `/model` + thinking level cycling works as usual. |
| **Vision** | `vision`-tagged models accept image input. |
| **Tool calling** | Standard OpenAI `tools`/`tool_choice`. |
| **Cost tracking** | Input/output/cache prices from the catalog ($ per 1M tokens, `cache_read_tokens` when DeepInfra publishes it). Override per model in `~/.pi/agent/models.json` if needed. |
| **Footer statusline** | While a DeepInfra model is active: `↑12.3k ↓4.5k · $0.042` for session tokens+cost, plus `M: $12.34 / $50.00` for DeepInfra monthly usage when a spending limit is configured (via `/payment/config`), or `M: $12.34` otherwise. The session figures count only assistant usage attributed to the DeepInfra provider, so switching to another model/provider mid-session never mixes their tokens/cost into these totals. Refresh with `/deepinfra-billing`. |

## Commands

- `/deepinfra-billing` — refresh the monthly-usage figure in the footer
  (also refreshed on session start / model select; no background polling).

## Configuration

- **API key**: `/login deepinfra`, `DEEPINFRA_API_KEY`, or the auth.json credential.
- **Per-model overrides** (prices, context, max tokens): standard pi
  `~/.pi/agent/models.json` mechanism, e.g.:

  ```json
  {
    "deepinfra": {
      "models": [
        {
          "id": "deepseek-ai/DeepSeek-V4-Flash-0731",
          "cost": { "input": 0.09, "output": 0.18, "cacheRead": 0.018, "cacheWrite": 0 }
        }
      ]
    }
  }
  ```

  Note: `models.json` `deepinfra` entries replace the extension's models for that
  provider — set a full `models` list there if you use it.
