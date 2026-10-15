# 在 Zhiro 窗口里用 DeepSeek Harness（dsh）

dsh 只能经 ACP（Agent Client Protocol）接进来。Zhiro 每条消息拉起一次 dsh，用 ACP 和它说话，再把过程翻成抽屉认得的样子；确认卡、撤销、停止、续接都和 Claude Code / Codex 一样。

## 前提

- 装好 dsh：`npm i -g @deepseek-ai/dsh`。Zhiro 找的是 npm 全局安装的位置；装在别处用环境变量 `ZHIRO_DSH_CLI` 指向它的 `lib/bin.js`。
- Node 22.15 或更新（dsh 自己的要求；低了配置页上的按钮是灰的）。
- **DeepSeek 的 API 密钥**：在 dsh 自己的模型页填，或设环境变量 `DEEPSEEK_API_KEY`。Zhiro 不经手这把钥匙。

## 步骤

1. Zhiro 窗口 → 配置 → 「AI 用哪家」→ 「DeepSeek（dsh）」。
2. 「后台整理改用内置模型」保持打开：dsh 还不能做后台整理。
3. 打开抽屉照常说话。

## 要知道的

- 它拿到的只有 Zhiro 的工具：它要用别的工具（读写文件、跑命令）时 Zhiro 一律拒绝。
- 模型在 dsh 自己的 acp 档里定（默认 deepseek-v4-flash），和它平时用的档分开。
- 续接：Zhiro 存着会话编号，下一条消息续上；续不上时带着之前的对话记录重新开始，抽屉里会提示一行。
- 不支持图片。

## 常见错误

- 「no API key for provider route "deepseek-official"」：还没填 DeepSeek 密钥，见前提。
- 按钮是灰的：没装 dsh，或 Node 低于 22.15。
