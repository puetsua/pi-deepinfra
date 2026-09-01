// Regression tests for the pi /reload stale-ctx race in the billing footer.
//
// Contract being tested (mirrors pi's ExtensionRunner semantics, verified against
// pi 0.84.x bundle code):
// - Every ctx getter calls assertActive() and throws once the runner is invalidated.
// - On /reload and session replacement, pi emits `session_shutdown` to the old
//   extension instance BEFORE invalidating its ctx.
// - Therefore a footer instance must never touch its captured ctx after it has
//   received onShutdown(), even if async work started earlier is still pending.
//
// Runs under Node >= 22.18 (native TS type stripping; billing.ts is import-type-only).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createUsageFooter } from "../billing.ts";

const PROVIDER = "deepinfra";
const STALE_MSG =
	"This extension ctx is stale after session replacement or reload. (test stub)";

function makePi() {
	return { on(_event, _handler) {} };
}

/** Mirrors pi's ExtensionContext: all getters throw once invalidated. */
function makeCtx() {
	let staleMessage = null;
	const setStatusCalls = [];
	const ctx = {
		invalidate(message = STALE_MSG) {
			staleMessage ||= message; // first message wins, like pi's runner.invalidate()
		},
		assertActive() {
			if (staleMessage) throw new Error(staleMessage);
		},
		get model() {
			ctx.assertActive();
			return { provider: PROVIDER };
		},
		get signal() {
			ctx.assertActive();
			return undefined;
		},
		modelRegistry: {
			async getProviderAuth() {
				return { auth: { apiKey: "test-key" } };
			},
		},
		sessionManager: {
			getEntries: () => [],
		},
		ui: {
			setStatus(_key, value) {
				setStatusCalls.push(value);
			},
		},
	};
	return { ctx, setStatusCalls };
}

/** Fetch stub whose responses settle only when we resolve them (queued). */
function installDeferredFetch() {
	const pending = [];
	globalThis.fetch = () => new Promise((resolve) => pending.push(resolve));
	const settleAll = (response) => {
		for (const resolve of pending.splice(0)) resolve(response);
	};
	return { pending, settleAll };
}

/** Pump microtasks until `condition()` holds (no timers, deterministic). */
async function flushUntil(condition, maxHops = 1000) {
	for (let i = 0; i < maxHops && !condition(); i++) {
		await Promise.resolve();
	}
	if (!condition()) throw new Error("condition not met within microtask budget");
}

const usageResponse = () => ({
	ok: true,
	json: async () => ({ months: [{ total_cost: 1234 }], limit: 1000 }),
});

test("orphaned onSessionStart continuation after reload must not throw or render", async () => {
	const { ctx, setStatusCalls } = makeCtx();
	const { pending, settleAll } = installDeferredFetch();

	try {
		const footer = createUsageFooter(makePi(), PROVIDER);
		const promise = footer.onSessionStart(ctx);

		// Let the continuation run until both billing fetches are in flight,
		// with the ctx still fresh (the fetches started before the reload).
		await flushUntil(() => pending.length >= 2);
		assert.equal(pending.length, 2, "billing fetches should be in flight");

		// Simulate /reload exactly as pi does: session_shutdown first, then invalidate.
		footer.onShutdown();
		ctx.invalidate();

		// The in-flight fetches settle only after the ctx went stale.
		settleAll(usageResponse());

		// Before the fix this rejects with the stale-ctx error (unhandled in index.ts,
		// crashing pi); after the fix it must resolve and never render.
		await promise;
		assert.equal(
			setStatusCalls.length,
			0,
			"retired footer instance must not touch ctx (no setStatus calls)",
		);
	} finally {
		globalThis.fetch = undefined;
	}
});

test("active footer renders session usage and monthly billing", async () => {
	const { ctx, setStatusCalls } = makeCtx();
	ctx.sessionManager.getEntries = () => [
		// DeepInfra assistant usage -> counted
		{
			message: {
				role: "assistant",
				provider: PROVIDER,
				usage: { input: 1500, output: 2000, cacheRead: 0, cacheWrite: 0, cost: { total: 0.012 } },
			},
		},
		// Other provider's assistant usage -> excluded
		{
			message: {
				role: "assistant",
				provider: "openai",
				usage: { input: 99999, output: 99999, cacheRead: 0, cacheWrite: 0, cost: { total: 5 } },
			},
		},
	];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => usageResponse();

	try {
		const footer = createUsageFooter(makePi(), PROVIDER);
		await footer.onSessionStart(ctx);

		const last = setStatusCalls.at(-1);
		assert.ok(last, "footer should set a status value");
		assert.ok(last.includes("↑1.5k ↓2.0k"), `session tokens missing in: ${last}`);
		assert.ok(last.includes("$0.012"), `session cost missing in: ${last}`);
		assert.ok(last.includes("M: $12.34 / $1000.00"), `monthly usage missing in: ${last}`);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
