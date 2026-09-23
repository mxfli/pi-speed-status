/**
 * Speed Status Extension
 *
 * 在 footer 状态栏显示最近一次助手回复的预填充/解码速度：
 *   ⚡ prefill 41.3k tok (39.2k cached) · 1.2k t/s (TTFT 34.2s) ｜ decode 456 tok · 11.8 t/s (avg 13.5)
 * 流式期间实时刷新解码速度（按累计输出 token / 流式耗时）。
 *
 * 口径：
 *   - prefill tok = input + cacheRead + cacheWrite（完整 prompt 规模，缓存部分单独标注）
 *   - prefill t/s = prefill tok / TTFT；TTFT 起点是响应头到达（message_start），
 *     不含连接建立 / 请求上传 / 服务端排队，远程 API 会略微高估；
 *     TTFT < 100ms 或结果 >1e6 t/s 时视为不可测，速度显 "—"（TTFT 仍固定显示）
 *   - decode  t/s = usage.output /（message_end - 首个流式 content 事件）
 *   - decode (avg) = 本 session 累计输出 token / 累计解码耗时（token 加权平均），
 *     切换模型时重新累计（跨模型速度不可比）
 *   - 报错消息（providers 用全零初始 usage）不覆盖上一条真实数据
 * 数据来自 message_end 的 usage，精确；流式中的实时值优先取每次 message_update
 * 的最新 usage（anthropic-messages 渠道有效）；openai-completions 等流式中途
 * 无 usage 的渠道按内容长度估算（CJK≈1 token/字，其余≈4 字符/token，加 ~ 前缀），
 * 仅作参考。
 *
 * 刷新机制：数值刷新由流事件驱动（message_update 节流 400ms），无事件时数字
 * 原地冻结、不空转；定时器只做看门狗——「停滞」是事件的缺席，只能靠时钟发现，
 * >3s 无流事件时标记 stalled。阶段标记取自 assistantMessageEvent 的类型
 * （thinking / text / toolCall）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export default function (pi: ExtensionAPI) {
	let tStart = 0;
	let tFirstToken = 0;
	let tLastEvent = 0; // 最后一次收到流事件的时间
	let phase = "decoding"; // 当前输出阶段：thinking / decoding / tool call
	let lastUsage: UsageLike | undefined;
	let estOutput = 0; // 按内容长度估算的输出 token（无流式 usage 时的兜底）
	let lastRenderAt = 0; // 上一次渲染数值的时间（事件驱动刷新的节流）
	let lastTickText = ""; // 上一次显示的文本（避免无意义重绘）
	let sessOutput = 0; // 本 session 累计输出 token
	let sessDecodeSecs = 0; // 本 session 累计解码耗时
	let timer: NodeJS.Timeout | undefined;

	const fmt = (n: number) =>
		n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`;

	// CJK 表意文字、日文假名、CJK/全角标点：现代 tokenizer 约 1 token/字
	const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/g;
	const estimateTokens = (text: string) => {
		const cjk = text.match(CJK_RE)?.length ?? 0;
		return cjk + (text.length - cjk) / 4;
	};

	// 当前输出 token 数与口径：usage 真实值优先，否则用估算值（显示加 ~ 前缀）
	function currentOut(): { out: number; approx: boolean } {
		const real = lastUsage?.output ?? 0;
		return real > 0 ? { out: real, approx: false } : { out: estOutput, approx: true };
	}

	// 流式期间的实时速度文本；输出为 0 或窗口太小时返回 undefined
	function speedText(now: number): string | undefined {
		const { out, approx } = currentOut();
		const dt = (now - tFirstToken) / 1000;
		if (out <= 0 || dt <= 0.2) return undefined;
		return `⚡ ${phase}… ${approx ? "~" : ""}${fmt(out)} tok · ${(out / dt).toFixed(1)} t/s`;
	}

	function stopTimer() {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	}

	pi.on("message_start", async (event) => {
		if (event.message.role !== "assistant") return;
		tStart = Date.now();
		tFirstToken = 0;
		tLastEvent = 0;
		phase = "decoding";
		lastUsage = undefined;
		estOutput = 0;
		lastRenderAt = 0;
		lastTickText = "";
		stopTimer();
	});

	pi.on("message_update", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const now = Date.now();
		if (!tFirstToken) tFirstToken = now;
		tLastEvent = now;
		// 阶段标记：thinking / text / toolCall（来自逐 token 流事件的类型）
		const evType = event.assistantMessageEvent?.type ?? "";
		if (evType.startsWith("thinking")) phase = "thinking";
		else if (evType.startsWith("text")) phase = "decoding";
		else if (evType.startsWith("toolcall")) phase = "tool call";
		// 每次更新都抓取最新 usage 快照：anthropic-messages 会原地累加 output，
		// openai-completions 只在末尾 chunk 整体替换，两者都能取到最新值
		lastUsage = event.message.usage ?? lastUsage;
		// 事件驱动刷新数值（节流 400ms）：有流事件才重算，无事件时数字原地冻结
		if (now - lastRenderAt >= 400) {
			lastRenderAt = now;
			// 估算只在渲染时计算：每个 delta 全量重扫内容开销大，
			// 而 handler 在流式关键路径上被串行 await，会拖慢 token 流
			let est = 0;
			for (const block of event.message.content ?? []) {
				if (block.type === "text") est += estimateTokens(block.text ?? "");
				else if (block.type === "thinking")
					est += estimateTokens(block.thinking ?? "");
				else if (block.type === "toolCall")
					est += estimateTokens(JSON.stringify(block.arguments ?? {}));
			}
			estOutput = Math.round(est);
			const text = speedText(now);
			if (text && text !== lastTickText) {
				lastTickText = text;
				ctx.ui.setStatus("speed", ctx.ui.theme.fg("dim", text));
			}
		}
		if (!timer) {
			// 看门狗：只做「停滞检测」这一件必须靠时钟的事——
			// 停滞 = 流事件的缺席，事件流本身不会为此发事件
			timer = setInterval(() => {
				if (!tFirstToken) return;
				const stalledSecs = Math.floor((Date.now() - tLastEvent) / 1000);
				if (stalledSecs <= 3) return;
				const { out, approx } = currentOut();
				if (out <= 0) return;
				const text = `⚡ ${phase}… ${approx ? "~" : ""}${fmt(out)} tok · stalled ${stalledSecs}s`;
				if (text !== lastTickText) {
					lastTickText = text;
					ctx.ui.setStatus("speed", ctx.ui.theme.fg("dim", text));
				}
			}, 500);
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		stopTimer();
		const usage = event.message.usage;
		if (!usage || !tStart) return;
		const theme = ctx.ui.theme;
		const ttft = ((tFirstToken || Date.now()) - tStart) / 1000;
		const decodeSecs = (Date.now() - (tFirstToken || Date.now())) / 1000;
		const cached = (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
		const promptToks = (usage.input ?? 0) + cached;
		const outToks = usage.output ?? 0;
		// 报错消息 usage 全零（providers 的初始空对象），不覆盖上一条真实数据
		if (promptToks === 0 && outToks === 0) return;
		// TTFT 窗口 <100ms 时噪声主导，>1e6 t/s 必为噪声：速度显 "—"，TTFT 仍固定显示
		const prefillSpeed = promptToks / ttft;
		const prefill =
			ttft > 0.1 && prefillSpeed <= 1e6 ? `${prefillSpeed.toFixed(1)} t/s` : "—";
		const ttftStr = ttft >= 1 ? `${ttft.toFixed(1)}s` : `${Math.round(ttft * 1000)}ms`;
		const decode = decodeSecs > 0.05 ? (outToks / decodeSecs).toFixed(1) : "—";
		// 累计本 session 的 decode 输出与耗时，算 token 加权平均速度
		if (decodeSecs > 0.05 && outToks > 0) {
			sessOutput += outToks;
			sessDecodeSecs += decodeSecs;
		}
		const sessAvg = sessDecodeSecs > 0 ? (sessOutput / sessDecodeSecs).toFixed(1) : "—";
		ctx.ui.setStatus(
			"speed",
			theme.fg("dim", "⚡ prefill ") +
				theme.fg(
					"accent",
					`${fmt(promptToks)} tok${cached > 0 ? ` (${fmt(cached)} cached)` : ""} · ${prefill}`,
				) +
				theme.fg("dim", ` (TTFT ${ttftStr})`) +
				theme.fg("dim", " ｜ decode ") +
				theme.fg("accent", `${fmt(outToks)} tok · ${decode} t/s`) +
				theme.fg("dim", ` (avg ${sessAvg})`),
		);
	});

	// 模型切换后速度水平不可比，session 平均重新累计
	pi.on("model_select", async () => {
		sessOutput = 0;
		sessDecodeSecs = 0;
	});

	pi.on("session_start", async (_event, ctx) => {
		stopTimer();
		tStart = 0;
		tFirstToken = 0;
		tLastEvent = 0;
		phase = "decoding";
		lastUsage = undefined;
		estOutput = 0;
		lastRenderAt = 0;
		lastTickText = "";
		sessOutput = 0;
		sessDecodeSecs = 0;
		ctx.ui.setStatus("speed", ctx.ui.theme.fg("dim", "⚡ —"));
	});

	pi.on("session_shutdown", async () => stopTimer());
}
