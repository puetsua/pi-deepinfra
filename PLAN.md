# Plan: pi extension adding the DeepInfra provider

Status: **IMPLEMENTED and VERIFIED end-to-end (2026-08-01)**. Extension installed at `~/.pi/agent/extensions/deepinfra/`.

Implemented files: `index.ts` (entry: async catalog fetch + `createProvider` registration with `auth.apiKey` reading the auth.json credential, footer wiring, `/deepinfra-billing` command), `models.ts` (catalog fetch/mapping + fallback list), `billing.ts` (session usage footer + monthly usage).

Verified live: 96 models registered; inference with the stored auth.json api_key (no env var) on `deepseek-ai/DeepSeek-V4-Flash-0731`; reasoning model `deepseek-ai/DeepSeek-R1-0528` with `:high` thinking level (thinking display + correct `reasoning_effort`); tool calling; usage recorded per message with correct $ costs (input/output/cacheRead); `/payment/usage?from=current` + `/payment/config` return data with the same Bearer key; `max_tokens` field accepted (30000 probe OK, no clamp needed).

Notes from implementation:
- Used the native `createProvider` form (not the legacy `ProviderConfig`) — the legacy form is credential-blind (env-only), while `createProvider`'s `auth.apiKey.resolve` receives the stored credential, which is how the user's auth.json key is used.
- `pricing.cache_read_tokens` present for 41/96 chat models → used for `cost.cacheRead`; falls back to input price.
- `maxTokens` = catalog `metadata.max_tokens` as-is (DeepInfra accepted 30000 when probed; no 16384 clamp).

## 1. Goal

A pi extension that registers a new provider `deepinfra`, giving pi access to all
DeepInfra-hosted chat models (open-source models plus hosted frontier models such as
Claude, Gemini, GPT-OSS) with correct streaming, reasoning-effort control, vision,
tool calling, and cost tracking.

## 2. Research findings

### 2.1 DeepInfra API (verified against live endpoint + docs)

| Fact | Value |
|---|---|
| Chat completions endpoint | `https://api.deepinfra.com/v1/openai/chat/completions` |
| OpenAI SDK base URL | `https://api.deepinfra.com/v1/openai` |
| Auth | `Authorization: Bearer <token>` (token from deepinfra.com/dash/api_keys) |
| API style | OpenAI Chat Completions compatible — pi's `openai-completions` API works |
| Model list endpoint | `https://api.deepinfra.com/v1/openai/models` — **public, no auth required** |
| Model list payload | `{ data: [{ id, metadata: { context_length, max_tokens, pricing: { input_tokens, output_tokens }, tags[], description } }] }` |
| Pricing units | `pricing.input_tokens` / `output_tokens` = **USD per 1M tokens** (same as pi's `cost` fields) |
| Max output tokens | hard cap **16384** for most models (some models higher) |
| Reasoning | `reasoning_effort` top-level param, values `none|minimal|low|medium|high|xhigh|max`; reasoning content streamed via `reasoning_content` deltas |
| Prompt caching | automatic; `cached_tokens`/`prompt_cache_hit_tokens` in usage; explicit `prompt_cache_key` supported; cached input billed at a reduced, per-model rate |
| Tools / structured output | `tools`, `tool_choice`, `response_format` (json / json_schema / regex) supported |
| Extra params (optional) | `service_tier` (`priority`/`flex`), `fail_fast`, `seed`, `min_p`, `top_k`, `stop_token_ids` |
| `max_tokens` vs `max_completion_tokens` | DeepInfra documents **`max_tokens`** only → must set `compat.maxTokensField: "max_tokens"` |

Catalog snapshot (live, 2026-08-01): **179 models total, 96 tagged `chat`**. Tags of
interest: `reasoning` (60), `reasoning_effort` (38), `vision`/`vlm` (47), `prompt_cache` (41).
Examples: `deepseek-ai/DeepSeek-V3-0324` ($0.24/$0.90, 163k), `deepseek-ai/DeepSeek-R1-0528`
($0.50/$2.15, 163k, reasoning), `Qwen/Qwen3-235B-A22B-Thinking-2507` (262k, reasoning),
`meta-llama/Llama-3.3-70B-Instruct`, `anthropic/claude-sonnet-5` ($2/$10, 1M ctx),
`google/gemini-3.1-pro` (1M ctx, vision).

### 2.2 pi extension/provider API (verified against installed docs + source)

- Extensions register providers via `pi.registerProvider(id, config)`; an **async factory**
  can fetch models before startup, so models show up in `pi --list-models` and the model picker
  (documented pattern for remote model discovery).
- `api: "openai-completions"` → delegates streaming to pi-ai's OpenAI Chat Completions
  implementation (OpenAI SDK). It already:
  - sends `Authorization: Bearer <key>` from `apiKey` (no `authHeader` flag needed),
  - parses `reasoning_content` / `reasoning` deltas into thinking blocks,
  - reads `prompt_tokens_details.cached_tokens` and `prompt_cache_hit_tokens` for cache accounting,
  - sends `stream_options: { include_usage: true }` (DeepInfra supports it — verified).
- `compat` flags required for DeepInfra (verified against `detectCompat()` source and
  live request probes — DeepInfra returns 422 at the auth layer, i.e. body accepted, for all of these):

| Flag | Value | Why |
|---|---|---|
| `maxTokensField` | `"max_tokens"` | DeepInfra does not use `max_completion_tokens` |
| `supportsStore` | `false` | don't send `store: false` (not part of DeepInfra contract) |
| `supportsDeveloperRole` | `false` | DeepInfra documents `system/user/assistant/tool` roles only → use `system` |
| `supportsReasoningEffort` | `true` | enables top-level `reasoning_effort` |
| `thinkingLevelMap` | `{ off: "none" }` | DeepInfra's level names match pi's except `off` → `none` |

- Reasoning serialization: with `thinkingFormat` unset (default OpenAI style) +
  `supportsReasoningEffort: true`, pi sends `reasoning_effort: <level>` top-level with the
  level name passed through — exactly DeepInfra's vocabulary (`minimal..max`).
- Extension placement: `.pi/extensions/deepinfra/index.ts` (project) or
  `~/.pi/agent/extensions/deepinfra/index.ts` (global), or package-style with
  `package.json` → `pi.extensions: ["./index.ts"]` → installable via `pi install`.
- Type-only imports (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`) resolve
  without npm install (gitlab-duo example confirms).

### 2.3 Key decisions

1. **Dynamic model discovery** via async factory (docs-endorsed pattern for remote catalogs).
   Models stay current as DeepInfra adds/removes models. Fallback to a curated static list
   if the catalog fetch fails at startup (so pi never hangs).
2. **Provider-config form** (`apiKey: "$DEEPINFRA_API_KEY"`, zero runtime deps) for v1 —
   proven pattern (custom-provider-gitlab-duo example), no npm install, works with jiti.
   Phase-2 upgrade: `createProvider()` + `auth.apiKey` (login prompt + env fallback) for
   interactive `/login deepinfra`.
3. **Only `chat`-tagged models** are registered (~96). Embeddings, image-gen, TTS, STT,
   video are out of scope for a coding assistant provider.
4. **Cost model**: `input`/`output` straight from the catalog (already $/1M).
   `cacheWrite: 0` (DeepInfra has no write price). `cacheRead`: per-model override map for
   documented cache prices (e.g. DeepSeek-V3-0324 $0.135, DeepSeek-R1 $0.35, Qwen3-Max
   $0.24, DeepSeek-V4-Flash $0.018); fallback `= input` (safe overestimate; calibrate later).
5. **maxTokens clamp**: `min(metadata.max_tokens, 16384)` (DeepInfra hard cap) with an
   override map for models that exceed it.

## 3. Project structure

```
D:/Projects/pi-deepinfra/
├── package.json      # name "pi-deepinfra", type module, pi.extensions: ["./index.ts"], zero deps
├── index.ts          # extension entry — async factory: fetch catalog → registerProvider("deepinfra", ...)
├── models.ts         # catalog fetch + mapping, CACHE_OVERRIDES, MAX_TOKENS overrides, curated FALLBACK_MODELS
├── README.md         # install/usage: env var, /login note, models.json overrides, troubleshooting
└── PLAN.md           # this file
```

## 4. Implementation steps

1. **Scaffold** `package.json` (pi package metadata, `pi.extensions` entry).
2. **`models.ts`**
   - `fetchDeepInfraCatalog()` → `GET https://api.deepinfra.com/v1/openai/models` (no auth, ~10s timeout).
   - Filter `tags.includes("chat")`; map to `ProviderModelConfig`:
     - `id`, `name` (tail of id, e.g. `DeepSeek-V3-0324`),
     - `reasoning: tags.includes("reasoning")`, `thinkingLevelMap: { off: "none" }` when reasoning,
     - `input: tags.includes("vision") ? ["text","image"] : ["text"]`,
     - `cost` from `pricing` (rounded to 4 dp) + `CACHE_OVERRIDES`,
     - `contextWindow: metadata.context_length`, `maxTokens: min(metadata.max_tokens, 16384)` + overrides,
     - `compat` block from §2.2 table.
   - `FALLBACK_MODELS`: ~10 curated entries (DeepSeek-V3-0324, DeepSeek-R1-0528, Qwen3-235B,
     Llama-3.3-70B, Llama-4-Maverick, Gemma-3-27b, Mistral-Small, claude-sonnet-5, gemini-3.1-pro)
     with hand-written values, used if the fetch fails.
3. **`index.ts`** — async factory: try fetch → register; on error log a warning and register
   fallback list. Provider config: `name: "DeepInfra"`, `baseUrl: "https://api.deepinfra.com/v1/openai"`,
   `apiKey: "$DEEPINFRA_API_KEY"`, `api: "openai-completions"`, `models`.
4. **`README.md`** — install (copy to `~/.pi/agent/extensions/deepinfra/`, or `pi install`,
   or `pi -e .`), set `DEEPINFRA_API_KEY`, model selection, thinking-level control,
   per-model `models.json` override example (e.g. calibrate cacheRead), troubleshooting.
5. **Optional hardening** (do after smoke tests pass): `message_end` handler to normalize
   DeepInfra overflow errors to `context_length_exceeded` if pi's auto-compaction doesn't
   recognize them (DeepInfra error text not yet verified).

## 5. Verification

| # | Check | Command |
|---|---|---|
| 1 | Models registered | `pi --list-models \| grep deepinfra` → ~96 entries |
| 2 | Basic text completion | `DEEPINFRA_API_KEY=... pi -p -m deepinfra/meta-llama/Llama-3.3-70B-Instruct "Say hi"` |
| 3 | Streaming + abort | interactive `pi`, Esc mid-response |
| 4 | Reasoning model | `pi -p -m deepinfra/deepseek-ai/DeepSeek-R1-0528 -l high "17 * 23"` → thinking shown, `reasoning_effort: high` in request |
| 5 | Vision model | attach an image with a `vision`-tagged model |
| 6 | Tool calling | prompt that needs bash/read → tool call executes |
| 7 | Usage/cost display | session shows input/output/cached tokens + $ |
| 8 | Context overflow → compaction | oversized prompt on small model (16384 cap model); may require step 4.5 normalizer |
| 9 | `/reload` | hot-reload picks up extension changes |

## 6. Risks / open questions

- **Cache pricing**: per-model, not in the public catalog endpoint. Mitigation: override map
  + documented `models.json` overrides; calibrate from a real billed request.
- **Overflow error format**: DeepInfra error text unverified (needs an auth'd request with an
  oversized prompt). Mitigation: `message_end` normalizer if needed.
- **Frontier models** (claude/gemini on DeepInfra): may be gated per-account; requests fail
  per-model with 401/403 — acceptable, model still listed.
- **`reasoning` param** (`ChatReasoningSettings`): DeepInfra also accepts a `reasoning` object
  on some models; v1 relies on `reasoning_effort` only. Verify against Qwen3-Max/DeepSeek-R1.
- **Model-name collisions**: `metadata.description` is long prose — model `name` uses the id
  tail to keep the picker readable.

## 6.5 Footer statusline: session usage + monthly billing (feature request)

Both are feasible with verified APIs:

### Session tokens + cost
- `ctx.ui.setStatus("deepinfra-usage", ...)` renders a footer statusline item
  (same API as examples/extensions/model-status.ts).
- Sum `message_end` `event.message.usage` (input/output/cacheRead/cacheWrite/totalTokens
  + `cost.total` in $) for `provider === "deepinfra"` messages.
- Recompute from `ctx.sessionManager.getEntries()` on `session_start` (resume), `session_compact`,
  and `model_select` (scoped to deepinfra) so totals survive compaction and model switches.
- Format: `↑12.3k ↓4.5k · $0.042` (input ↑, output ↓). Clear the status when the active
  model is not a deepinfra model.

### Monthly usage + configured limit
- `GET https://api.deepinfra.com/v1/payment/usage?from=current` → `months[0].total_cost`
  (integer **cents** → /100 for USD) + per-model items.
- `GET https://api.deepinfra.com/v1/payment/config` → `{ limit: number }` — the spending
  limit the user configured on DeepInfra (negative/null = no limit). Verified in the live
  OpenAPI spec: schemas `ConfigOut { limit }`, `UsageOut { months[] { period, total_cost, items[] } }`.
- Auth: `ctx.modelRegistry.getProviderAuth("deepinfra")` resolves the same Bearer API key
  used for chat. 401/network → show nothing (graceful).
- Footer: `M: $12.34 / $50.00` when a positive limit exists, else `M: $12.34`.
- Refresh: on `session_start`, plus a registered `/deepinfra-billing` command for on-demand
  refresh. No background polling by default (avoid rate-limit noise); optional 10-min timer
  started in `session_start`, cleaned up in `session_shutdown`.
- Note: there is no public API to change the limit from the extension (`POST /payment/config`
  exists but we only read); the user sets it on DeepInfra's billing page.

## 7. Phase 2 (future, not in this PR)

- `createProvider()` + `auth.apiKey` interactive `/login deepinfra` (prompt, store in auth store,
  env fallback in `resolve`).
- `service_tier: "flex"` support (cheaper best-effort tier) behind a setting.
- Optional `prompt_cache_key` session-affinity for higher cache hit rates.
- Publish as a pi package (`pi install pi-deepinfra`).
