/**
 * Smoke test — loads the extension with a fake pi API and drives synthetic
 * streaming responses, asserting the status line updates.
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

const thinkText = "a".repeat(40); // ≈ 10 tokens
const replyText = "b".repeat(80); // ≈ 20 tokens
const usage = (output: number) => ({ input: 10000, cacheRead: 30000, output });

await emit("session_start", {});
assert.equal(statuses.at(-1), "⚡ —");

await emit("message_start", { message: assistantMessage(undefined, []) });

// t+150ms: thinking starts. Under the 400ms render throttle, nothing yet.
now = t0 + 150;
await emit("message_update", {
	message: assistantMessage(usage(10), [{ type: "thinking", thinking: thinkText }]),
	assistantMessageEvent: { type: "thinking_delta" },
});
assert.equal(statuses.at(-1), "⚡ —", "no render before the throttle window");

// t+700ms: live TK segment. 10 tok / 0.55s = 18.2 t/s.
now = t0 + 700;
await emit("message_update", {
	message: assistantMessage(usage(10), [{ type: "thinking", thinking: thinkText }]),
	assistantMessageEvent: { type: "thinking_delta" },
});
assert.match(statuses.at(-1) ?? "", /^⚡ TK… 10 tok · 18\.2 t\/s$/);

// t+1200ms: text starts. TK freezes and is kept; DC window is still too small.
now = t0 + 1200;
await emit("message_update", {
	message: assistantMessage(usage(60), [
		{ type: "thinking", thinking: thinkText },
		{ type: "text", text: replyText },
	]),
	assistantMessageEvent: { type: "text_delta" },
});
assert.match(statuses.at(-1) ?? "", /^⚡ TK 10 tok · 18\.2 t\/s$/, "TK kept after thinking ends");

// t+2000ms: DC grows while TK stays frozen. 20 tok / 0.8s = 25.0 t/s.
now = t0 + 2000;
await emit("message_update", {
	message: assistantMessage(usage(80), [
		{ type: "thinking", thinking: thinkText },
		{ type: "text", text: replyText },
	]),
	assistantMessageEvent: { type: "text_delta" },
});
assert.match(
	statuses.at(-1) ?? "",
	/^⚡ TK 10 tok · 18\.2 t\/s ｜ DC… 20 tok · 25\.0 t\/s$/,
);

// t+2500ms: message ends. usage.output 600 is split by estimated ratio 10:20
// into TK 200 / DC 400. Speeds use their own phase windows: TK 0.55s, DC 1.3s.
now = t0 + 2500;
await emit("message_end", {
	message: assistantMessage({ ...usage(600), cacheWrite: 0 }, [
		{ type: "thinking", thinking: thinkText },
		{ type: "text", text: replyText },
	]),
});
const final = statuses.at(-1) ?? "";
// PF prefill speed is k-formatted: 40000 tok / 0.15s = 266.7k t/s.
assert.match(final, /⚡ PF 40\.0k tok \(30\.0k cached\) · 266\.7k t\/s \(TTFT 150ms\)/);
assert.match(final, /TK 200 tok · 363\.6 t\/s/);
// session avg = 600 tok / 2.35s = 255.3 t/s
assert.match(final, /DC 400 tok · 307\.7 t\/s \(avg 255\.3\)/);

// Second response: text only, session avg accumulates.
await emit("message_start", { message: assistantMessage(undefined, []) });
now = t0 + 3000;
await emit("message_update", {
	message: assistantMessage({ input: 5000, cacheRead: 0, output: 50 }, [
		{ type: "text", text: "c".repeat(20) },
	]),
	assistantMessageEvent: { type: "text_delta" },
});
now = t0 + 3500;
await emit("message_end", {
	message: assistantMessage({ input: 5000, cacheRead: 0, cacheWrite: 0, output: 100 }, [
		{ type: "text", text: "c".repeat(20) },
	]),
});
// avg = 700 tok / 2.85s = 245.6 t/s
assert.match(
	statuses.at(-1) ?? "",
	/⚡ PF 5\.0k tok · 10\.0k t\/s \(TTFT 500ms\) ｜ DC 100 tok · 200\.0 t\/s \(avg 245\.6\)/,
);

// Zero-usage error replies must not clobber the last real reading.
now = t0 + 4000;
await emit("message_start", { message: assistantMessage(undefined, []) });
now = t0 + 4500;
await emit("message_end", {
	message: assistantMessage({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, []),
});
assert.match(statuses.at(-1) ?? "", /\(avg 245\.6\)/, "zero-usage error kept old data");

// No streaming usage available: estimated live tokens keep the ~ prefix,
// and the session avg is still shown.
await emit("message_start", { message: assistantMessage(undefined, []) });
now = t0 + 4600;
await emit("message_update", {
	message: assistantMessage(undefined, [{ type: "text", text: "d".repeat(400) }]),
	assistantMessageEvent: { type: "text_delta" },
});
now = t0 + 5000;
await emit("message_update", {
	message: assistantMessage(undefined, [{ type: "text", text: "d".repeat(400) }]),
	assistantMessageEvent: { type: "text_delta" },
});
assert.match(
	statuses.at(-1) ?? "",
	/^⚡ DC… ~100 tok · 250\.0 t\/s \(avg 245\.6\)$/,
);

await emit("session_shutdown", {});
console.log("smoke test passed");
