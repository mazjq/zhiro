# 在 WorkBuddy 里用 Zhiro

WorkBuddy 是桌面应用、没有无头命令行，所以装不进 Zhiro 的窗口；在它里面用 Zhiro 的办法是打开 Zhiro 的 **agent 工作目录**。

## 步骤

1. Zhiro 在跑。工作目录的位置在 Zhiro 窗口 → 配置 → 「AI 用哪家」卡片最下面（默认 `<数据目录>\agent`）。
2. 把那个目录里 `.workbuddy\mcp.json` 的 `zhiro` 一段复制进 `%USERPROFILE%\.workbuddy\mcp.json`（和已有的并列），然后**从托盘图标彻底退出 WorkBuddy 再打开**（只关窗口不算，它常驻在托盘，不会重读配置）。连接器里应出现 **zhiro**。
   - WorkBuddy 的自定义 MCP 只走 HTTP：那段配置是 `url: http://127.0.0.1:8787/mcp` 加一个 `x-jobos-key` 请求头（它会把 `Authorization` 头删掉，所以钥匙走这个头），不是命令行形式（命令行形式它会列出但不启动，2026-10-13 实测）。换了数据目录或钥匙，重新复制一次。
   - 新加的 MCP 要在 WorkBuddy 的「连接器中心」里点一次信任 / 启用（它对每个新配置记一次批准），之后会话里才会挂上。
3. 说：「今天有什么截止的」「关注武汉的控制算法岗」「给第一个准备申请」。

## 确认和撤销

默认都在 WorkBuddy 的对话里完成：有影响的事它复述一遍问你，你说可以，它再确认；撤销也在对话里说。想改成只能在 Zhiro 窗口确认：在数据文件夹的 `config\jobos.yaml` 里 `agent:` 下加一行 `harnessConfirm: window`，重启 Zhiro（配置页上不再有这个选项）。

它永远不会点网申的提交按钮；模型登录、凭据只能你在 Zhiro 窗口里做。

## 要知道的

- 技能在 `.workbuddy\skills\zhiro`（和 OpenClaw 技能格式一样）。每次 Zhiro 启动重写，不要手改。
- 10 分钟内直接做的写操作超过 10 条，其余会变成确认卡。

## 常见错误

- `UNAUTHORIZED`：Zhiro 没在跑，或目录是另一个数据目录的 Zhiro 写的。
- `FORBIDDEN`：本人专用的操作，或确认被设成了「只在 Zhiro 窗口」。
