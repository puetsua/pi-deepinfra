/**
 * pi-deepinfra — DeepInfra provider for pi.
 *
 * Registers the `deepinfra` provider with:
 * - Dynamic model discovery from the public catalog (https://api.deepinfra.com/v1/openai/models),
 *   loaded lazily at session start with a curated fallback list when the catalog is
 *   unreachable — startup never blocks on the network, and the public catalog
 *   is picked up even when no API key is configured.
 * - `openai-completions` streaming with DeepInfra-specific compat flags
 *   (max_tokens, system role, top-level reasoning_effort for thinking levels).
 * - API key auth reading pi's credential store (~/.pi/agent/auth.json →
 *   `deepinfra` api_key entry) with DEEPINFRA_API_KEY env fallback; `/login deepinfra`
 *   prompts and stores the key.
 * - A footer statusline showing session input/output tokens + cost, and DeepInfra
 *   monthly usage (with the configured spending limit when set) via
 *   /payment/usage and /payment/config.
 *
 * Usage:
 *   pi -e .                       # run with the extension
 *   /login deepinfra              # interactive API key entry (or set DEEPINFRA_API_KEY)
 *   /model deepinfra/deepseek-ai/DeepSeek-V4-Flash-0731
 *   /deepinfra-billing            # refresh monthly usage in the footer
 */

import { createProvider, openAICompletionsApi, type ApiKeyAuth, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, MessageEndEvent } from "@earendil-works/pi-coding-agent";

import { createUsageFooter } from "./billing";
import { BASE_URL, fetchDeepInfraModels, fallbackModels, PROVIDER_ID } from "./models";

const deepInfraApiKeyAuth: ApiKeyAuth = {
	name: "DeepInfra API key",
	async login(interaction) {
		const key = await interaction.prompt({
			type: "secret",
			message: "DeepInfra API key (https://deepinfra.com/dash/api_keys)",
		});
		return { type: "api_key", key };
	},
	async resolve({ ctx, credential }) {
		// Stored credential (auth.json / /login) first, env var as ambient fallback.
		const key = credential?.key ?? (await ctx.env("DEEPINFRA_API_KEY"));
		if (!key) return undefined;
		return {
			auth: { apiKey: key },
			source: credential?.key ? "stored API key" : "DEEPINFRA_API_KEY",
		};
	},
};

// The public catalog must load even when no API key is configured. pi's own
// `refreshModels` path is credential-gated (it skips providers whose auth can't
// resolve), so we cannot rely on `createProvider.fetchModels` for a keyless
// provider. Instead we register a self-managed mutable model list (the same
// pattern pi's llama.cpp provider uses) and swap the live catalog in lazily.
const CATALOG_TTL_MS = 60 * 60 * 1_000;

export default function (pi: ExtensionAPI): void {
	// 1. Register the provider IMMEDIATELY with the curated fallback list and
	//    NEVER block startup on the network (that hangs pi at "model catalog
	//    loading"). `createProvider` captures this array by reference and reads
	//    it on every getModels() call, so swapping its contents in place below
	//    is picked up by pi without re-registering.
	const models: Model<"openai-completions">[] = fallbackModels();
	pi.registerProvider(
		createProvider({
			id: PROVIDER_ID,
			name: "DeepInfra",
			baseUrl: BASE_URL,
			auth: { apiKey: deepInfraApiKeyAuth },
			models,
			api: openAICompletionsApi(),
		}),
	);

	// 2. Swap in the live public catalog lazily (fire-and-forget, never awaited,
	//    honors the session abort signal). Works with or without an API key.
	let lastFetch = 0;
	const refreshCatalog = async (signal?: AbortSignal): Promise<void> => {
		if (Date.now() - lastFetch < CATALOG_TTL_MS) return;
		lastFetch = Date.now(); // mark in-flight so a slow/stalled fetch can't re-enter
		try {
			const live = await fetchDeepInfraModels(signal);
			models.splice(0, models.length, ...live);
		} catch (error) {
			console.warn(
				`[pi-deepinfra] catalog fetch failed (${error instanceof Error ? error.message : String(error)}); keeping ${models.length} fallback/known models`,
			);
		}
	};

	// 3. Footer statusline: session usage + monthly billing.
	const footer = createUsageFooter(pi, PROVIDER_ID);

	pi.on("session_start", (_event, ctx) => {
		void refreshCatalog(ctx.signal);
		void footer.onSessionStart(ctx);
	});
	pi.on("message_end", (event: MessageEndEvent, ctx) => {
		footer.onMessageEnd(event, ctx);
	});
	pi.on("session_compact", (_event, ctx) => {
		footer.onSessionCompact(ctx);
	});
	pi.on("model_select", (_event, ctx) => {
		footer.onModelSelect(ctx);
	});
	pi.on("session_shutdown", () => {
		footer.onShutdown();
	});

	pi.registerCommand("deepinfra-billing", {
		description: "Refresh DeepInfra monthly usage shown in the footer",
		handler: async (_args, ctx) => {
			await footer.refreshMonthly(ctx);
			ctx.ui.notify(
				ctx.model?.provider === PROVIDER_ID
					? "DeepInfra monthly usage refreshed"
					: "DeepInfra monthly usage refreshed (not active model)",
				"info",
			);
		},
	});
}
