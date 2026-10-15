# 在 Codex 里用 Zhiro

在 Zhiro 的 **agent 工作目录** 里打开 Codex 就能用；离开那个目录就都不在，不碰你 `~/.codex` 的设置。

## 步骤

1. Zhiro 在跑。工作目录的位置在 Zhiro 窗口 → 配置 → 「AI 用哪家」卡片最下面（默认 `<数据目录>\agent`）。
2. 终端里：

   ```
   cd <那个目录>
   codex
   ```

   首次会问是否信任这个目录，选是（目录里的 `.codex/config.toml` 只有一条 zhiro 的 MCP 配置）。
3. 说：「今天有什么截止的」「关注武汉的控制算法岗」「给第一个准备申请」「打开网申」。

## 确认和撤销

默认都在 Codex 的对话里完成：有影响的事它复述一遍问你，你说可以，它再确认；撤销也在对话里说。想改成只能在 Zhiro 窗口确认：在数据文件夹的 `config\jobos.yaml` 里 `agent:` 下加一行 `harnessConfirm: window`，重启 Zhiro（配置页上不再有这个选项）。

它永远不会点网申的提交按钮；模型登录、凭据只能你在 Zhiro 窗口里做。

## 要知道的

- 技能在 `.agents/skills/zhiro`（Codex 认的项目级位置），`AGENTS.md` 一句话指过去。每次 Zhiro 启动重写，不要手改。
- Codex 对 MCP 工具默认要逐个审批；在它问「允许 zhiro 的 xx 吗」时允许即可。想免审批，在 `~/.codex/config.toml` 里加 `[mcp_servers.zhiro] default_tools_approval_mode = "approve"`（这是全局设置，你自己决定）。
- 10 分钟内直接做的写操作超过 10 条，其余会变成确认卡。
- 无头方式：`codex exec --skip-git-repo-check "今天有什么截止的"`（在这个目录里）。

## 常见错误

- `UNAUTHORIZED`：Zhiro 没在跑，或目录是另一个数据目录的 Zhiro 写的。
- `FORBIDDEN`：本人专用的操作，或确认被设成了「只在 Zhiro 窗口」。
- 没看到 zhiro 工具：没信任这个目录；重开 Codex 并选信任。
