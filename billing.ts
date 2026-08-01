/**
 * DeepInfra footer statusline: session token usage + cost, and DeepInfra
 * monthly usage (with the user's configured spending limit, if any).
 *
 * Data sources (all verified against the live API):
 * - Session usage: pi message/entry `usage` (input/output/cacheRead/cacheWrite
 *   tokens + cost in $), recomputed from session entries on every update.
 * - Monthly spend: GET https://api.deepinfra.com/payment/usage?from=current
 *   -> months[0].total_cost (integer CENTS).
 * - Configured limit: GET https://api.deepinfra.com/payment/config
 *   -> { limit } (USD; negative = no limit).
 */

import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, MessageEndEvent } from "@earendil-works/pi-coding-agent";

const BILLING_BASE = "https://api.deepinfra.com";
const MONTHLY_TTL_MS = 60_000;

interface DeepInfraUsageMonth {
	period?: string;
	total_cost?: number;
	items?: unknown[];
}
interface DeepInfraUsageResponse {
	months?: DeepInfraUsageMonth[];
}
interface DeepInfraConfigResponse {
	/** Spending limit in USD. Negative = no limit. */
	limit?: number;
}

interface MonthlyUsage {
	spentUsd: number;
	limitUsd: number | null;
	fetchedAt: number;
}

const sumUsage = (usage: Usage | undefined) =>
	usage
		? {
				input: usage.input || 0,
				output: usage.output || 0,
				cacheRead: usage.cacheRead || 0,
				cacheWrite: usage.cacheWrite || 0,
				cost: usage.cost?.total || 0,
			}
		: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(Math.round(n));
}

export interface UsageFooter {
	onSessionStart(ctx: ExtensionContext): Promise<void>;
	onMessageEnd(event: MessageEndEvent, ctx: ExtensionContext): void;
	onSessionCompact(ctx: ExtensionContext): void;
	onModelSelect(ctx: ExtensionContext): void;
	onShutdown(): void;
	refreshMonthly(ctx: ExtensionContext): Promise<void>;
	render(ctx: ExtensionContext): void;
}

export function createUsageFooter(pi: ExtensionAPI, providerId: string): UsageFooter {
	const STATUS_KEY = "deepinfra";
	let monthly: MonthlyUsage | null = null;
	let monthlyInFlight: Promise<void> | null = null;

	const isActiveProvider = (ctx: ExtensionContext) => ctx.model?.provider === providerId;

	async function fetchMonthly(ctx: ExtensionContext): Promise<void> {
		const auth = await ctx.modelRegistry.getProviderAuth(providerId);
		const apiKey = auth?.auth.apiKey;
		if (!apiKey) return; // unconfigured — leave monthly hidden

		try {
			const headers = { Authorization: `Bearer ${apiKey}` };
			const [usageRes, configRes] = await Promise.all([
				fetch(`${BILLING_BASE}/payment/usage?from=current`, {
					headers,
					signal: ctx.signal,
				}),
				fetch(`${BILLING_BASE}/payment/config`, { headers, signal: ctx.signal }),
			]);
			if (!usageRes.ok || !configRes.ok) return;
			const usage = (await usageRes.json()) as DeepInfraUsageResponse;
			const config = (await configRes.json()) as DeepInfraConfigResponse;
			const current = usage.months?.[0];
			if (!current) return;
			const limit = typeof config.limit === "number" && config.limit > 0 ? config.limit : null;
			monthly = {
				spentUsd: (current.total_cost ?? 0) / 100, // API returns cents
				limitUsd: limit,
				fetchedAt: Date.now(),
			};
		} catch {
			// network/auth errors: keep last-known monthly value, never crash the session
		}
	}

	async function refreshMonthly(ctx: ExtensionContext): Promise<void> {
		if (monthly && Date.now() - monthly.fetchedAt < MONTHLY_TTL_MS) return;
		if (!monthlyInFlight) {
			monthlyInFlight = fetchMonthly(ctx).finally(() => {
				monthlyInFlight = null;
			});
		}
		await monthlyInFlight;
	}

	function render(ctx: ExtensionContext): void {
		if (!isActiveProvider(ctx)) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}

		const parts: string[] = [];

		// Session tokens + cost, recomputed from session entries (survives /compact)
		let t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
		for (const entry of ctx.sessionManager.getEntries()) {
			const u = sumUsage(entry.message?.usage);
			t.input += u.input;
			t.output += u.output;
			t.cacheRead += u.cacheRead;
			t.cacheWrite += u.cacheWrite;
			t.cost += u.cost;
		}
		if (t.input > 0 || t.output > 0) {
			parts.push(`↑${formatTokens(t.input)} ↓${formatTokens(t.output)}`);
		}
		if (t.cost > 0) {
			parts.push(`$${t.cost < 0.01 ? t.cost.toFixed(4) : t.cost.toFixed(3)}`);
		}

		// Monthly usage + configured limit
		if (monthly) {
			const spent = `$${monthly.spentUsd.toFixed(2)}`;
			parts.push(
				monthly.limitUsd != null
					? `M: ${spent} / $${monthly.limitUsd.toFixed(2)}`
					: `M: ${spent}`,
			);
		}

		ctx.ui.setStatus(STATUS_KEY, parts.length > 0 ? parts.join(" · ") : undefined);
	}

	return {
		async onSessionStart(ctx) {
			if (isActiveProvider(ctx)) {
				await refreshMonthly(ctx);
			}
			render(ctx);
		},
		onMessageEnd(_event, ctx) {
			render(ctx);
		},
		onSessionCompact(ctx) {
			render(ctx);
		},
		onModelSelect(ctx) {
			if (isActiveProvider(ctx)) {
				void refreshMonthly(ctx);
			}
			render(ctx);
		},
		onShutdown() {
			monthly = null;
		},
		async refreshMonthly(ctx) {
			monthly = null; // force refetch
			await refreshMonthly(ctx);
			render(ctx);
		},
		render,
	};
}
