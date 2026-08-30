/**
 * DeepInfra model catalog: fetch + mapping to pi Model<> objects.
 *
 * The catalog endpoint (https://api.deepinfra.com/v1/openai/models) is public
 * and returns everything we need per model: context length, max output tokens,
 * $/1M pricing (including cache_read_tokens on prompt-cache-enabled models),
 * and capability tags (chat / reasoning / vision / prompt_cache).
 */

import type { Model, ThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";

export const PROVIDER_ID = "deepinfra";
export const BASE_URL = "https://api.deepinfra.com/v1/openai";
export const CATALOG_URL = `${BASE_URL}/models`;

/** Chat models only — embeddings, image-gen, TTS, STT, video are out of scope. */
const CHAT_TAG = "chat";

export interface DeepInfraCatalogModel {
	id: string;
	name?: string;
	metadata?: {
		description?: string;
		context_length?: number;
		max_tokens?: number;
		pricing?: {
			input_tokens?: number;
			output_tokens?: number;
			cache_read_tokens?: number;
		};
		tags?: string[];
	};
}

export interface DeepInfraCatalog {
	data: DeepInfraCatalogModel[];
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** "deepseek-ai/DeepSeek-V4-Flash-0731" -> "DeepSeek-V4-Flash-0731" */
export function displayName(id: string): string {
	const tail = id.split("/").pop() ?? id;
	return tail;
}

/**
 * Generic thinking-level mapping for every other reasoning model: pi levels
 * pass through by name (`minimal`…`high`; `xhigh`/`max` not offered), `off`
 * → "none" (DeepInfra disables reasoning).
 */
export const THINKING_LEVEL_MAP: ThinkingLevelMap = { off: "none" };

/**
 * A family of reasoning models sharing one `reasoning_effort` vocabulary on
 * DeepInfra. Supported `levels` map 1:1 (pi name == API value); anything else
 * is hidden (`null`) so pi only offers the real distinct levels. `off` is the
 * value sent to disable thinking (`null` when the family has no no-thinking
 * mode — reasoning_effort is then omitted and thinking stays on).
 */
interface ThinkingFamily {
	/** Model-id prefixes identifying the family, e.g. "deepseek-ai/". */
	prefixes: readonly string[];
	/** pi levels the family accepts natively, in pi order. */
	levels: readonly ThinkingLevel[];
	/** `reasoning_effort` value that disables thinking; null if impossible. */
	off: string | null;
	/** Reference for the family's reasoning API. */
	docs: string;
}

/**
 * Reasoning families whose `reasoning_effort` vocabulary deviates from the
 * generic pass-through. First matching prefix wins.
 */
const THINKING_FAMILIES: readonly ThinkingFamily[] = [
	{
		// low/medium→high and xhigh→max are aliases, so only low/high/max
		// are offered; `off` disables thinking via DeepInfra's "none".
		prefixes: ["deepseek-ai/"],
		levels: ["low", "high", "max"],
		off: "none",
		docs: "https://api-docs.deepseek.com/guides/thinking_mode/",
	},
	{
		// GLM-5.3 / GLM-5.3-Flash have no no-thinking mode (`thinking.type`
		// only supports `enabled`), so `off: null` hides the off level.
		prefixes: ["zai-org/GLM-5.3"],
		levels: ["low", "high", "max"],
		off: null,
		docs: "https://docs.z.ai/guides/vlm/glm-5.3-flash",
	},
];

const PI_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** Derive a `ThinkingLevelMap` from a family's supported levels + off behavior. */
function buildThinkingMap(family: ThinkingFamily): ThinkingLevelMap {
	const map: ThinkingLevelMap = { off: family.off };
	for (const level of PI_LEVELS) {
		map[level] = family.levels.includes(level) ? level : null;
	}
	return map;
}

/** Derived maps, built once at module load. */
const THINKING_MAPS: ReadonlyArray<{ prefixes: readonly string[]; map: ThinkingLevelMap }> =
	THINKING_FAMILIES.map((family) => ({ prefixes: family.prefixes, map: buildThinkingMap(family) }));

function thinkingMapFor(id: string, reasoning: boolean): ThinkingLevelMap | undefined {
	if (!reasoning) return undefined;
	const match = THINKING_MAPS.find(({ prefixes }) => prefixes.some((prefix) => id.startsWith(prefix)));
	return match?.map ?? THINKING_LEVEL_MAP;
}

/**
 * Compatibility flags required by DeepInfra's OpenAI-compatible API
 * (verified against the live endpoint + pi-ai's openai-completions serializer):
 * - maxTokensField: "max_tokens"     (DeepInfra does not use max_completion_tokens)
 * - supportsStore: false             (don't send OpenAI's `store` param)
 * - supportsDeveloperRole: false     (DeepInfra documents system/user/assistant/tool)
 * - supportsReasoningEffort: true    (top-level reasoning_effort param)
 */
export const DEEPINFRA_COMPAT = {
	maxTokensField: "max_tokens",
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: true,
} as const;

export function mapCatalogModel(raw: DeepInfraCatalogModel): Model<"openai-completions"> {
	const metadata = raw.metadata ?? {};
	const tags = metadata.tags ?? [];
	const pricing = metadata.pricing ?? {};
	const reasoning = tags.includes("reasoning");
	const inputPrice = round4(pricing.input_tokens ?? 0);
	const outputPrice = round4(pricing.output_tokens ?? 0);
	const cacheRead = round4(pricing.cache_read_tokens ?? inputPrice);
	const hasVision = tags.includes("vision") || tags.includes("vlm");

	return {
		id: raw.id,
		name: raw.name ?? displayName(raw.id),
		api: "openai-completions",
		provider: PROVIDER_ID,
		baseUrl: BASE_URL,
		reasoning,
		thinkingLevelMap: thinkingMapFor(raw.id, reasoning),
		input: hasVision ? ["text", "image"] : ["text"],
		cost: { input: inputPrice, output: outputPrice, cacheRead, cacheWrite: 0 },
		contextWindow: metadata.context_length ?? 128_000,
		maxTokens: metadata.max_tokens ?? 4096,
		compat: DEEPINFRA_COMPAT,
	};
}

/**
 * Fetch and map the live catalog. Throws on network/parse errors.
 *
 * Honors an external abort signal (e.g. pi's session context) in addition to a
 * hard 15s timeout so a stalled catalog request is never able to block the
 * caller for longer than the timeout. Called lazily at session start to swap
 * the live catalog into the provider — never awaited during startup.
 */
export async function fetchDeepInfraModels(signal?: AbortSignal): Promise<Model<"openai-completions">[]> {
	const timeout = AbortSignal.timeout(15_000);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const response = await fetch(CATALOG_URL, { signal: combined });
	if (!response.ok) {
		throw new Error(`catalog fetch failed: HTTP ${response.status}`);
	}
	const catalog = (await response.json()) as DeepInfraCatalog;
	return catalog.data
		.filter((m) => m.metadata?.tags?.includes(CHAT_TAG))
		.map(mapCatalogModel);
}

/**
 * Curated fallback list used when the live catalog cannot be fetched at
 * startup (offline, DNS, etc.). Values captured from the live catalog.
 */
export function fallbackModels(): Model<"openai-completions">[] {
	const entries: Array<[string, number, number, number, number, boolean, boolean]> = [
		// id, ctx, max, $in, $out, reasoning, vision
		["deepseek-ai/DeepSeek-V4-Flash-0731", 1_048_576, 1_048_576, 0.09, 0.18, true, false],
		["deepseek-ai/DeepSeek-V3-0324", 163_840, 163_840, 0.24, 0.9, false, false],
		["deepseek-ai/DeepSeek-R1-0528", 163_840, 163_840, 0.5, 2.15, true, false],
		["Qwen/Qwen3-235B-A22B-Thinking-2507", 262_144, 262_144, 0.23, 2.3, true, false],
		["Qwen/Qwen2.5-72B-Instruct", 32_768, 32_768, 0.36, 0.4, false, false],
		["meta-llama/Llama-3.3-70B-Instruct", 131_072, 131_072, 0.2, 0.32, false, false],
		["meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8", 1_048_576, 1_048_576, 0.2, 0.8, false, true],
		["google/gemma-3-27b-it", 131_072, 131_072, 0.08, 0.16, false, true],
		["zai-org/GLM-5.3-Flash", 1_048_576, 1_048_576, 0.15, 0.5, true, true],
		["mistralai/Mistral-Small-3.2-24B-Instruct-2506", 131_072, 131_072, 0.075, 0.2, false, false],
		["google/gemini-3.1-pro", 1_000_000, 1_000_000, 2.0, 12.0, true, true],
	];

	return entries.map(([id, contextWindow, maxTokens, input, output, reasoning, vision]) => ({
		id,
		name: displayName(id),
		api: "openai-completions",
		provider: PROVIDER_ID,
		baseUrl: BASE_URL,
		reasoning,
		thinkingLevelMap: thinkingMapFor(id, reasoning),
		input: vision ? (["text", "image"] as const) : (["text"] as const),
		cost: {
			input,
			output,
			cacheRead: input,
			cacheWrite: 0,
		},
		contextWindow,
		maxTokens,
		compat: DEEPINFRA_COMPAT,
	}));
}
