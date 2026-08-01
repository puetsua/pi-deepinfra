/**
 * pi-deepinfra — DeepInfra provider for pi.
 *
 * Registers the `deepinfra` provider with:
 * - Dynamic model discovery from the public catalog (https://api.deepinfra.com/v1/openai/models)
 *   at startup, with a curated fallback list when the catalog is unreachable.
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

import { createProvider, openAICompletionsApi, type ApiKeyAuth } from "@earendil-works/pi-ai";
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

export default async function (pi: ExtensionAPI): Promise<void> {
	// 1. Discover models — fail soft: fall back to a curated list so startup
	//    never hangs on the network.
	let models;
	try {
		models = await fetchDeepInfraModels();
	} catch (error) {
		models = fallbackModels();
		console.warn(
			`[pi-deepinfra] catalog fetch failed (${error instanceof Error ? error.message : String(error)}); using ${models.length} fallback models`,
		);
	}

	// 2. Register the provider. `createProvider` is the native pi-ai form, so
	//    auth resolves against pi's credential store — the api_key credential
	//    stored in ~/.pi/agent/auth.json is picked up automatically.
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

	// 3. Footer statusline: session usage + monthly billing.
	const footer = createUsageFooter(pi, PROVIDER_ID);

	pi.on("session_start", (_event, ctx) => {
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
