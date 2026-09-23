/**
 * Smoke test — loads the extension with a fake pi API and drives a synthetic
 * streaming response, asserting the status line updates.
 *
 * No dependencies and no pi install required: the extension's only pi import is
 * type-only and erased at runtime, so this runs with node's type stripping.
 *
 *   npm test
 */

import assert from "node:assert/strict";
import speedStatus from "../extensions/speed-status.ts";

type Handler = (event: any, ctx: any) => Promise<void> | void;

const handlers: Record<string, Handler> = {};
const statuses: Array<string | undefined> = [];

const theme = { fg: (_color: string, text: string) => text };
const ctx = {
	ui: {
		theme,
		setStatus: (key: string, text: string | undefined) => {
			assert.equal(key, "speed");
			statuses.push(text);
		},
	},
};

const pi = {
	on: (event: string, handler: Handler) => {
		handlers[event] = handler;
	},
} as any;

speedStatus(pi);
assert.ok(handlers.session_start, "session_start handler registered");

// Controllable clock: the extension only reads Date.now(). A non-zero base is
// required because the extension treats tStart === 0 as "no response yet".
const t0 = 1_000_000;
let now = t0;
Date.now = () => now;

const emit = async (event: string, payload: any) => {
	await handlers[event](payload, ctx);
};

const assistantMessage = (usage: any, content: any[]) => ({
	role: "assistant",
	usage,
	content,
});

await emit("session_start", {});
assert.equal(statuses.at(-1), "⚡ —");

await emit("message_start", { message: assistantMessage(undefined, []) });

// t=150ms: first stream event, establishes TTFT. Under the 400ms render
// throttle, so nothing is shown yet.
now = t0 + 150;
await emit("message_update", {
	message: assistantMessage({ input: 10000, cacheRead: 30000, output: 100 }, [
		{ type: "text", text: "hello" },
	]),
	assistantMessageEvent: { type: "text_delta" },
});
assert.equal(statuses.at(-1), "⚡ —", "no render before the throttle window");

// t=1200ms: usage now reports 500 output tokens; live decode speed renders.
now = t0 + 1200;
await emit("message_update", {
	message: assistantMessage({ input: 10000, cacheRead: 30000, output: 500 }, [
		{ type: "text", text: "hello world" },
	]),
	assistantMessageEvent: { type: "text_delta" },
});
assert.match(statuses.at(-1) ?? "", /⚡ decoding… 500 tok · 476\.2 t\/s/);

// t=1500ms: message ends. TTFT = 150ms, decode window = 1.35s, 600 tokens.
now = t0 + 1500;
await emit("message_end", {
	message: assistantMessage(
		{ input: 10000, cacheRead: 30000, cacheWrite: 0, output: 600 },
		[{ type: "text", text: "hello world" }],
	),
});
const final = statuses.at(-1) ?? "";
assert.match(final, /prefill 40\.0k tok \(30\.0k cached\) · 266666\.7 t\/s \(TTFT 150ms\)/);
assert.match(final, /decode 600 tok · 444\.4 t\/s \(avg 444\.4\)/);

// Session average accumulates across responses; zero-usage error replies must
// not clobber the last real reading.
await emit("message_start", { message: assistantMessage(undefined, []) });
now = t0 + 2000;
await emit("message_update", {
	message: assistantMessage({ input: 5000, cacheRead: 0, output: 50 }, [
		{ type: "text", text: "again" },
	]),
	assistantMessageEvent: { type: "text_delta" },
});
now = t0 + 2500;
await emit("message_end", {
	message: assistantMessage(
		{ input: 5000, cacheRead: 0, cacheWrite: 0, output: 100 },
		[{ type: "text", text: "again" }],
	),
});
assert.match(statuses.at(-1) ?? "", /\(avg 378\.4\)/);

now = t0 + 3000;
await emit("message_start", { message: assistantMessage(undefined, []) });
now = t0 + 3500;
await emit("message_end", {
	message: assistantMessage(
		{ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
		[],
	),
});
assert.match(statuses.at(-1) ?? "", /\(avg 378\.4\)/, "zero-usage error kept old data");

await emit("session_shutdown", {});
console.log("smoke test passed");
