# pi-speed-status

Pi 扩展：在 footer 状态栏显示最近一次助手回复的**预填充 / 解码速度与 TTFT**。

```
⚡ PF 73.4k tok (73.2k cached) · 372.7k t/s (TTFT 197ms) ｜ TK 1.2k tok · 45.0 t/s ｜ DC 456 tok · 207.3 t/s (avg 238.2)
```

- 流式期间实时刷新当前阶段：`TK` = thinking、`DC` = decode（含工具调用输出）；
  TK 段在思考结束后**冻结保留**，DC 段继续增长，session `(avg)` 始终显示
- 结束后显示精确口径：`PF` = `input + cacheRead + cacheWrite`（缓存单独标注），
  `TK / DC` 按流式内容估算比例拆分 `usage.output`（两段之和为精确总量）；
  TK 速度按思考窗口、DC 速度按解码窗口分别计算
- 速度值 ≥1000 自动换算 `k`，≥1e6 换算 `M`
- >3s 无流事件时显示 `stalled Ns`
- 切换模型时重置 session 平均值（跨模型速度不可比）
- 报错消息的全零 usage 不覆盖上一条真实数据
- 无流式 usage 的渠道按内容长度估算，数值带 `~` 前缀

## 安装

要求 pi 0.87 或更新版本（使用 `ctx.ui.setStatus` / `ctx.ui.theme` 标准扩展 API）。

```bash
# 本地目录（不复制，直接指向磁盘路径）
pi install /absolute/path/to/pi-speed-status

# git（推荐多机复用；@v2 为固定 ref，避免每次拉取上游变动）
pi install git:github.com/mxfli/pi-speed-status@v2

# 临时试用，不写入 settings
pi -e /absolute/path/to/pi-speed-status
```

安装后重启 pi，footer 第二行即出现速度状态。

> **已在本机用旧扩展的注意**：若 `~/.pi/agent/extensions/speed-status.ts` 还在，
> 会与包内扩展同时加载（两套 handler 都跑）。安装前先删掉或改名该文件：
> `mv ~/.pi/agent/extensions/speed-status.ts ~/.pi/agent/extensions/speed-status.ts.bak`

## 管理

```bash
pi list                          # 查看已安装包
pi update --extensions           # 更新包（git 固定 ref 不会移动）
pi remove git:github.com/mxfli/pi-speed-status
pi config                        # 交互式启用/禁用扩展（Tab 切换全局 / 项目级）
```

## 包结构

```
extensions/speed-status.ts   # 全部逻辑，单文件无依赖
test/smoke.ts                # 冒烟测试：假 pi API + 合成流事件
```

npm 包名为 `@mxfli/pi-speed-status`（git 安装不依赖包名），MIT 许可。

## 开发

```bash
npm test          # 无需安装依赖（node 原生类型剥离 + 假 pi API）
npm install       # 仅类型检查需要，约 176MB
npm run typecheck
```

扩展由 pi 通过 jiti 加载，TypeScript 免编译，无需构建步骤。
`@earendil-works/pi-coding-agent` 由 pi 提供，声明为 `peerDependencies`（`*`），不打包。

## 口径与实现说明

详细口径、刷新机制（事件驱动 + 节流 + 停滞看门狗）见
[`extensions/speed-status.ts`](extensions/speed-status.ts) 文件头注释。
