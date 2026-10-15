# 其他 agent 怎么接 Zhiro

任何支持 MCP 的 agent（Cursor、Zed、Cline、dsh、你自己写的）都能用。两种接法，都不需要改 Zhiro。

## 一、stdio（推荐）

给它一条命令：

```
zhiro mcp
```

（从源码跑的：`node <仓库>/bin/jobos-mcp.cjs`。）Claude Code 一行：`claude mcp add zhiro -- zhiro mcp`；Codex 一行：`codex mcp add zhiro --env ZHIRO_RESULT_MODE=text -- zhiro mcp`（`ZHIRO_RESULT_MODE=text`：每个结果只给一份文字版；Codex 默认会把文字版和结构化两份都交给模型，约多一倍 token）。

环境变量（可选）：`ZHIRO_DATA`（数据目录，不设就用 Zhiro 自己记住的位置）、`ZHIRO_URL`（默认 `http://127.0.0.1:8787`）、`ZHIRO_ACTOR`（审计标签，随便起个名）。旧名 `JOBOS_*` 也认。这个进程自己读数据目录里的 `config/.agent-token`，不用你处理钥匙。Zhiro 的 agent 工作目录（`<数据目录>/agent`）里各家的配置文件就是这么写的，照抄即可。

## 二、HTTP（能带请求头的客户端）

- MCP：`http://127.0.0.1:8787/mcp`，请求头 `Authorization: Bearer <config/.agent-token 的内容>`（删 `Authorization` 头的客户端用 `x-jobos-key`）。
- 或者直接调工具：`POST http://127.0.0.1:8787/api/tools/<工具名>`，同样的请求头，`GET /api/tools` 列契约。

不支持把钥匙放在 URL 里。

## 技能文件

agent 工作目录里的 `SKILL.md`（`.claude/skills/zhiro/`、`.agents/skills/zhiro/`、`.workbuddy/skills/zhiro/` 三处内容相同；源文件是仓库的 `agent-skills/zhiro/SKILL.md`）是给 agent 读的使用说明：流程、确认和撤销怎么做、主题调研怎么查。你的 agent 认哪种位置就复制到哪。

## 身份与权限

拿 `.agent-token` 的一律是 agent 身份：读工具直接调；写工具分三档——本地可逆的直接做（记下来，你能撤销）、有影响的先出确认卡、模型登录和凭据不做。确认卡默认可以在 agent 里由它代你确认（你同意之后），也可以改成只在 Zhiro 窗口点。请求头 `x-jobos-actor` 只是审计标签，自称本人也不会变成本人。详见 [设计决定](../contrib/decisions.md)。
