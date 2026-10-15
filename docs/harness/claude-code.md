# 在 Claude Code 里用 Zhiro

不想用 Zhiro 的窗口聊天、习惯直接在 Claude Code 里说话：Zhiro 给你准备了一个 **agent 工作目录**，在那里打开 Claude Code 就能用，离开那个目录就都不在，不碰你的全局设置。

## 步骤

1. Zhiro 在跑。工作目录的位置在 Zhiro 窗口 → 配置 → 「AI 用哪家」卡片最下面（默认 `<数据目录>\agent`）。
2. 终端里：

   ```
   cd <那个目录>
   claude
   ```

   首次会问「要不要启用这个项目的 .mcp.json 里的 zhiro」，选是。
3. 说：「今天有什么截止的」「关注武汉的控制算法岗」「给第一个准备申请」「打开网申」。

## 确认和撤销

默认设置下都在 Claude Code 的对话里完成：有影响的事它会复述一遍问你，你说可以，它再确认；要撤销就说撤销。想改成只能在 Zhiro 窗口确认：在数据文件夹的 `config\jobos.yaml` 里 `agent:` 下加一行 `harnessConfirm: window`，重启 Zhiro（配置页上不再有这个选项）。

它永远不会点网申的提交按钮；模型登录、凭据这类只能你在 Zhiro 窗口里做。

## 要知道的

- 这个目录里有 `.mcp.json`（指向 Zhiro 的 MCP）和技能 `.claude/skills/zhiro`（怎么用 Zhiro 的说明）。每次 Zhiro 启动都会重写，不要手改、不要在里面建文件。
- 10 分钟内直接做的写操作超过 10 条，其余会变成确认卡。
- 无头方式一样可用：`claude -p --mcp-config .mcp.json --strict-mcp-config --allowedTools "mcp__zhiro__*" "今天有什么截止的"`。

## 常见错误

- 工具报 `UNAUTHORIZED`：Zhiro 没在跑，或者这个目录是另一个数据目录的 Zhiro 写的（看目录里 README 的最后一行）。
- 工具报 `FORBIDDEN`：这是本人专用的操作，或者确认被设成了「只在 Zhiro 窗口」。
- 没看到 zhiro 工具：重开 Claude Code，启用项目的 MCP。
