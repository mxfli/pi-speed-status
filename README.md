# pi-speed-status

Pi 扩展：在 footer 状态栏显示最近一次助手回复的预填充 / 思考 / 解码速度与 TTFT。

```
⚡ PF 73.4k tok (73.2k cached) · 372.7k t/s (TTFT 197ms) ｜ TK 1.2k tok · 45.0 t/s ｜ DC 456 tok · 207.3 t/s (avg 238.2)
```

- 流式期间实时刷新：`TK` = thinking，`DC` = decode（含工具调用输出）；TK 段在思考结束后
  冻结保留，session `(avg)` 始终显示
- `PF` = `input + cacheRead + cacheWrite`；`TK / DC` 按流式内容比例拆分精确的 `usage.output`，
  各自按阶段窗口计算速度
- 速度 ≥1000 换算 `k`，≥1e6 换算 `M`；>3s 无流事件显示 `stalled Ns`
- 无流式 usage 的渠道按内容长度估算（带 `~` 前缀）；切换模型重置 avg；
  全零 usage 的报错消息不覆盖上一条真实数据

## 安装

要求 pi 0.87+。

```bash
pi install git:github.com/mxfli/pi-speed-status
```

跟随 `main`，更新用 `pi update --extensions`；需要锁版本时改用 `git:github.com/mxfli/pi-speed-status@v2`。

## 开发

```bash
npm test              # 无需依赖，假 pi API + 合成流事件
npm install           # 仅类型检查需要
npm run typecheck
```

扩展由 pi 通过 jiti 加载，无需构建；口径与刷新机制的详细说明见
[`extensions/speed-status.ts`](extensions/speed-status.ts) 文件头注释。

MIT
