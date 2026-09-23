/**
 * Speed Status Extension
 *
 * 在 footer 状态栏显示最近一次助手回复的预填充/思考/解码速度：
 *   ⚡ PF 73.4k tok (73.2k cached) · 372.7k t/s (TTFT 197ms) ｜ TK 1.2k tok · 45.0 t/s ｜ DC 456 tok · 207.3 t/s (avg 238.2)
 * 流式期间实时刷新当前阶段（TK = thinking，DC = decode，含工具调用输出）；TK 段在
 * 思考结束后冻结保留、不会消失，DC 段继续增长；session 平均速度 (avg) 始终保留。
 * 速度值 ≥1000 自动换算 k，≥1e6 换算 M。
 *
 * 口径：
 *   - PF tok = input + cacheRead + cacheWrite（完整 prompt 规模，缓存部分单独标注）
 *   - PF t/s = PF tok / TTFT；TTFT 起点是响应头到达（message_start），
 *     不含连接建立 / 请求上传 / 服务端排队，远程 API 会略微高估；
 *     TTFT < 100ms 或结果 >1e6 t/s 时视为不可测，速度显 "—"（TTFT 仍固定显示）
 *   - TK / DC tok：用流式内容估算的 thinking / 文本字符比例拆分 usage.output，
 *     两段之和恒等于精确输出总量（现代 tokenizer 下字符比例近似 token 比例）
 *   - TK t/s = TK tok /（最后一个 thinking 事件 - 第一个 thinking 事件）
 *   - DC t/s = DC tok /（message_end - 第一个 text/toolCall 事件）
 *   - avg = 本 session 累计输出 token / 累计生成窗口（首个流事件 → message_end），
 *     token 加权平均；切换模型时重新累计（跨模型速度不可比）
 *   - 报错消息（providers 用全零初始 usage）不覆盖上一条真实数据
 * 数据来自 message_end 的 usage，精确；流式中的实时值优先取每次 message_update
 * 的最新 usage（anthropic-messages 渠道有效）；openai-completions 等流式中途
 * 无 usage 的渠道按内容长度估算（CJK≈1 token/字，其余≈4 字符/token，加 ~ 前缀），
 * 仅作参考。
 *
 * 刷新机制：数值刷新由流事件驱动（message_update 节流 400ms），无事件时数字
 * 原地冻结、不空转；定时器只做看门狗——「停滞」是事件的缺席，只能靠时钟发现，
 * >3s 无流事件时标记 stalled。
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
	let estThink = 0; // thinking 内容估算的 token
	let estDecode = 0; // text / toolCall 内容估算的 token
	let tThinkStart = 0;
	let tThinkEnd = 0;
	let tDecodeStart = 0;
	let tDecodeEnd = 0;
	let lastRenderAt = 0; // 上一次渲染数值的时间（事件驱动刷新的节流）
	let lastTickText = ""; // 上一次显示的文本（避免无意义重绘）
	let sessOutput = 0; // 本 session 累计输出 token
	let sessDecodeSecs = 0; // 本 session 累计生成窗口耗时
	let timer: NodeJS.Timeout | undefined;

	const PHASE_ABBR: Record<string, string> = {
		thinking: "TK",
		decoding: "DC",
		"tool call": "DC",
	};

	const fmt = (n: number) =>
		n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`;
	const fmtSpeed = (n: number) =>
		n >= 1e6
			? `${(n / 1e6).toFixed(1)}M`
			: n >= 1000
				? `${(n / 1000).toFixed(1)}k`
				: n.toFixed(1);

	// CJK 表意文字、日文假名、CJK/全角标点：现代 tokenizer 约 1 token/字
	const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/g;
	const estimateTokens = (text: string) => {
		const cjk = text.match(CJK_RE)?.length ?? 0;
		return cjk + (text.length - cjk) / 4;
	};

	// 单段速度文本；token 为 0 或窗口太小时返回 undefined
	function segText(
		label: string,
		tokens: number,
		secs: number,
		growing: boolean,
		approx: boolean,
	): string | undefined {
		if (tokens <= 0 || secs <= 0.2) return undefined;
		return `${label}${growing ? "…" : ""} ${approx ? "~" : ""}${fmt(tokens)} tok · ${fmtSpeed(tokens / secs)} t/s`;
	}

	// 流式期间的实时文本：TK 段思考结束后冻结保留，DC 段随流增长，末尾保留 session avg
	function speedText(now: number): string | undefined {
		const approx = (lastUsage?.output ?? 0) <= 0;
		const thinkLive = phase === "thinking";
		const parts: string[] = [];
		if (estThink > 0 && tThinkStart) {
			const end = thinkLive ? now : tThinkEnd || now;
			const text = segText("TK", estThink, (end - tThinkStart) / 1000, thinkLive, approx);
			if (text) parts.push(text);
		}
		if (estDecode > 0 && tDecodeStart) {
			const decLive = !thinkLive;
			const end = decLive ? now : tDecodeEnd || now;
			const text = segText("DC", estDecode, (end - tDecodeStart) / 1000, decLive, approx);
			if (text) parts.push(text);
		}
		if (parts.length === 0) {
			// 无 content 流可用时退回总量口径
			const out = lastUsage?.output ?? 0;
			const dt = (now - tFirstToken) / 1000;
			if (out <= 0 || dt <= 0.2) return undefined;
			return `⚡ ${PHASE_ABBR[phase] ?? phase}… ${fmt(out)} tok · ${fmtSpeed(out / dt)} t/s`;
		}
		const avg = sessDecodeSecs > 0 ? ` (avg ${fmtSpeed(sessOutput / sessDecodeSecs)})` : "";
		return `⚡ ${parts.join(" ｜ ")}${avg}`;
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
		estThink = 0;
		estDecode = 0;
		tThinkStart = 0;
		tThinkEnd = 0;
		tDecodeStart = 0;
		tDecodeEnd = 0;
		lastRenderAt = 0;
		lastTickText = "";
		stopTimer();
	});

	pi.on("message_update", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const now = Date.now();
		if (!tFirstToken) tFirstToken = now;
		tLastEvent = now;
		// 阶段标记与各阶段窗口（thinking / text+toolCall 两段）
		const evType = event.assistantMessageEvent?.type ?? "";
		if (evType.startsWith("thinking")) {
			phase = "thinking";
			if (!tThinkStart) tThinkStart = now;
			tThinkEnd = now;
		} else if (evType.startsWith("text") || evType.startsWith("toolcall")) {
			phase = evType.startsWith("text") ? "decoding" : "tool call";
			if (!tDecodeStart) tDecodeStart = now;
			tDecodeEnd = now;
		}
		// 每次更新都抓取最新 usage 快照：anthropic-messages 会原地累加 output，
		// openai-completions 只在末尾 chunk 整体替换，两者都能取到最新值
		lastUsage = event.message.usage ?? lastUsage;
		// 事件驱动刷新数值（节流 400ms）：有流事件才重算，无事件时数字原地冻结
		if (now - lastRenderAt >= 400) {
			lastRenderAt = now;
			// 估算只在渲染时计算：每个 delta 全量重扫内容开销大，
			// 而 handler 在流式关键路径上被串行 await，会拖慢 token 流
			let think = 0;
			let dec = 0;
			for (const block of event.message.content ?? []) {
				if (block.type === "text") dec += estimateTokens(block.text ?? "");
				else if (block.type === "thinking")
					think += estimateTokens(block.thinking ?? "");
				else if (block.type === "toolCall")
					dec += estimateTokens(JSON.stringify(block.arguments ?? {}));
			}
			estThink = Math.round(think);
			estDecode = Math.round(dec);
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
				const stageTokens = phase === "thinking" ? estThink : estDecode;
				const out = stageTokens > 0 ? stageTokens : (lastUsage?.output ?? 0);
				if (out <= 0) return;
				const text = `⚡ ${PHASE_ABBR[phase] ?? phase}… ${fmt(out)} tok · stalled ${stalledSecs}s`;
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
		const now = Date.now();
		const ttft = ((tFirstToken || now) - tStart) / 1000;
		const genSecs = (now - (tFirstToken || now)) / 1000;
		const cached = (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
		const promptToks = (usage.input ?? 0) + cached;
		const outToks = usage.output ?? 0;
		// 报错消息 usage 全零（providers 的初始空对象），不覆盖上一条真实数据
		if (promptToks === 0 && outToks === 0) return;

		// 精确输出总量按流式内容估算的字符比例拆成 TK / DC 两段
		let thinkEst = 0;
		let decEst = 0;
		for (const block of event.message.content ?? []) {
			if (block.type === "text") decEst += estimateTokens(block.text ?? "");
			else if (block.type === "thinking")
				thinkEst += estimateTokens(block.thinking ?? "");
			else if (block.type === "toolCall")
				decEst += estimateTokens(JSON.stringify(block.arguments ?? {}));
		}
		const estTotal = thinkEst + decEst;
		let tkToks = 0;
		let dcToks = outToks;
		if (estTotal > 0 && outToks > 0) {
			tkToks = Math.round((outToks * thinkEst) / estTotal);
			dcToks = outToks - tkToks;
		}

		// TTFT 窗口 <100ms 时噪声主导，>1e6 t/s 必为噪声：速度显 "—"，TTFT 仍固定显示
		const prefillSpeed = promptToks / ttft;
		const prefill =
			ttft > 0.1 && prefillSpeed <= 1e6 ? `${fmtSpeed(prefillSpeed)} t/s` : "—";
		const ttftStr = ttft >= 1 ? `${ttft.toFixed(1)}s` : `${Math.round(ttft * 1000)}ms`;
		const tkSecs = tThinkStart && tThinkEnd ? (tThinkEnd - tThinkStart) / 1000 : 0;
		const dcSecs = tDecodeStart ? (now - tDecodeStart) / 1000 : 0;
		const tkRate = tkSecs > 0.05 && tkToks > 0 ? `${fmtSpeed(tkToks / tkSecs)} t/s` : "—";
		const dcRate = dcSecs > 0.05 && dcToks > 0 ? `${fmtSpeed(dcToks / dcSecs)} t/s` : "—";
		// 累计本 session 的输出与生成窗口，算 token 加权平均速度
		if (genSecs > 0.05 && outToks > 0) {
			sessOutput += outToks;
			sessDecodeSecs += genSecs;
		}
		const sessAvg = sessDecodeSecs > 0 ? fmtSpeed(sessOutput / sessDecodeSecs) : "—";

		let status =
			theme.fg("dim", "⚡ PF ") +
			theme.fg(
				"accent",
				`${fmt(promptToks)} tok${cached > 0 ? ` (${fmt(cached)} cached)` : ""} · ${prefill}`,
			) +
			theme.fg("dim", ` (TTFT ${ttftStr})`);
		if (tkToks > 0) {
			status +=
				theme.fg("dim", " ｜ TK ") +
				theme.fg("accent", `${fmt(tkToks)} tok · ${tkRate}`);
		}
		if (dcToks > 0) {
			status +=
				theme.fg("dim", " ｜ DC ") +
				theme.fg("accent", `${fmt(dcToks)} tok · ${dcRate}`);
		}
		status += theme.fg("dim", ` (avg ${sessAvg})`);
		ctx.ui.setStatus("speed", status);
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
		estThink = 0;
		estDecode = 0;
		tThinkStart = 0;
		tThinkEnd = 0;
		tDecodeStart = 0;
		tDecodeEnd = 0;
		lastRenderAt = 0;
		lastTickText = "";
		sessOutput = 0;
		sessDecodeSecs = 0;
		ctx.ui.setStatus("speed", ctx.ui.theme.fg("dim", "⚡ —"));
	});

	pi.on("session_shutdown", async () => stopTimer());
}
