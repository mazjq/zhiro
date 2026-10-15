<div align="center">

# Zhiro · 职路

**帮你找到尽可能好的职业道路——不只是下一份工作。**

[English](README.md) | 简体中文

[![CI](https://github.com/mazjq/zhiro/actions/workflows/ci.yml/badge.svg)](https://github.com/mazjq/zhiro/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@mazjq/zhiro)](https://www.npmjs.com/package/@mazjq/zhiro)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

大多数求职工具让你投得更快；职路帮你选得更好。它把三件事放在一起看：

- **你自己**：会什么、还缺什么；
- **公司**：经营怎么样、研发投入多少、员工待遇和激励好不好、在产业链上的位置是不是难以替代；
- **机会**：所有相关岗位，每个都有可靠的截止日期。

然后从找岗位到拿 offer，一路帮你推进。职路跑在你自己的电脑上，配合你已经在用的 AI agent（Claude Code、Codex、WorkBuddy，或任何支持 MCP 的客户端）。先为国内校招做，社招也能用。

![职路：按你的画像排好的岗位](docs/assets/jobs.png)

<sub>截图里都是虚构数据。</sub>

## 为什么用职路

### 1. 看清该补什么，而不只是被筛掉

一般的筛选会悄悄去掉你「不符合」的岗位。职路把它们变成**机会缺口**：

1. 在所有和你方向相关的岗位里，找出你画像里还看不出来的要求；
2. 按能力归类，算出每补上一项能多投多少个岗位、多少家公司；
3. 标明每项是哪种情况：「画像里没提到」（先核实，不等于不会）、「有可迁移的经验」，还是你确认过的真缺口。

这样，一长串「不符合」就变成一张「接下来值得补什么」的短清单。你答一句「我会」或「没做过」，相关岗位会重新匹配。

### 2. 看公司，不只看招聘启事

招聘启事说明不了在这家公司能走多远。职路给你和你的 agent 判断一家公司的数据：

- **经营数据**：上市公司（A 股、港股、美股、新三板）近三年的营收、净利、增速、毛利率、研发投入、员工数、人均支付给职工的现金。
- **一年公告里的信号**：股权激励 / 员工持股、扩产和新产线、政府补助、专精特新（往往是产业链上难以替代的一环）、大股东减持。
- **行业背景**：某个行业或概念有哪些上市公司、券商最近的研报，以及美国劳工统计局（BLS）的岗位薪资统计，可以拿来对照。

让你的 agent 调研一个行业或一家公司，它会用这些数据工具再加上网搜索，写成一份你能核对的报告：每个结论都写明出处，报告里的公司还会和岗位库里的岗位对上号。于是「这家值不值得去、去了能不能成长」，变成一个可以拿证据回答的问题。

<img src="docs/assets/company-intel.png" alt="一家公司的情况卡：营收、研发、人均职工现金" width="520">

### 3. 该知道的一个不漏

- **岗位库每天自动更新**：读公司自己的招聘站（Moka、北森、飞书招聘、大易、前程无忧、智联校园、国聘等），也读你自己的表格（飞书多维表格、CSV）。
- **截止日期多源核对**：几个来源说法不一样时会对照合并，每个截止日期都标明来源、有没有核实过。
- **按画像匹配**：画像是一张张能核对的小卡片（教育、技能、项目、偏好），岗位按它来匹配。

| 今日：快截止的、等你拍板的 | 求职资料：匹配、选简历、网申都从这里取值 |
|---|---|
| ![今日](docs/assets/today.png) | ![求职资料](docs/assets/profile.png) |

### 4. 每份申请都往前推

- **投递进度**：关注 → 准备申请 → 已投递 → 笔试面试 → 结果，带提醒。
- **能读招聘邮件的收件箱**：认出笔试、面试邀请，对上是哪份申请，给出建议的更新，由你确认。
- **网申填到「提交」前**：用一个单独的 Chrome 档案，按你的画像和合适的那份简历填表，然后停下，「提交」由你自己点。

| 投递：每一步进度，岗位要求原文随手可查 | 收件箱：招聘邮件变成下一步 |
|---|---|
| ![投递](docs/assets/pipeline.png) | ![收件箱](docs/assets/inbox.png) |

### 5. 你的 agent、你的数据、你定规矩

- **agent 的操作有分寸**：能撤销的事直接做，你随时能撤销；有影响的事变成确认卡，等你点；登录和凭据 agent 碰不到。
- **数据留在本机**：全部放在你电脑上的一个文件夹里。升级在副本上做，核对全对才换上；检查数据、回到升级前，各一条命令。

## 安装

**装了 Node 22.13 或更新？**

```bash
npx @mazjq/zhiro                 # 试一下
npm i -g @mazjq/zhiro && zhiro   # 长期用（装好后命令叫 zhiro）
```

**没有 Node？** 一行命令，自带它需要的一切（自带一份官方 Node，按 nodejs.org 的校验和核对过；不动你系统里的东西）：

```powershell
# Windows（PowerShell）
irm https://github.com/mazjq/zhiro/releases/latest/download/install.ps1 | iex
```

```bash
# macOS / Linux
curl -fsSL https://github.com/mazjq/zhiro/releases/latest/download/install.sh | sh
```

<details><summary>想先看看脚本再运行？</summary>

下载 [`install.ps1`](https://github.com/mazjq/zhiro/releases/latest/download/install.ps1) 或 [`install.sh`](https://github.com/mazjq/zhiro/releases/latest/download/install.sh)，看过再运行。再运行一次就是升级，上一个版本会保留。
</details>

**想改代码？** 见 [CONTRIBUTING.md](CONTRIBUTING.md)：`git clone`、`pnpm install`、`pnpm dev`。

第一次启动会问数据放哪（直接回车用默认位置），然后在浏览器里打开。

### 让你的 agent 帮你装

把这句话贴给 Claude Code、Codex 或任何编程 agent：

```text
按 https://raw.githubusercontent.com/mazjq/zhiro/main/llms-install.md 帮我安装 Zhiro（用 curl 取原文，不要用网页摘要）。
```

## 在你自己的 agent 里用

职路是一组 MCP 工具。启动职路后，给你的 agent 接一次：

<details><summary>Claude Code</summary>

```bash
claude mcp add zhiro -- zhiro mcp            # Windows：claude mcp add zhiro -- cmd /c zhiro mcp
```
或者在职路的 agent 工作目录（设置页里有位置）里打开 Claude Code，那里都配好了。[详细](docs/harness/claude-code.md)
</details>

<details><summary>Codex</summary>

```bash
codex mcp add zhiro --env ZHIRO_RESULT_MODE=text -- zhiro mcp
# Windows：codex mcp add zhiro --env ZHIRO_RESULT_MODE=text -- cmd /c zhiro mcp
#（ZHIRO_RESULT_MODE：让 Codex 每个结果只收一份，省约一半 token）
```
[详细](docs/harness/codex.md)
</details>

<details><summary>WorkBuddy、Cursor 和其他 MCP 客户端</summary>

[WorkBuddy](docs/harness/workbuddy.md) · [任何 MCP 客户端](docs/harness/others.md)
</details>

然后直接说：「这周有什么截止的」「关注武汉的控制算法岗」「调研一下人形机器人行业」「给第一个岗位填网申」。

职路窗口里的聊天面板也可以选由谁来回答（Claude Code、Codex，或可选的内置助手）：[docs/harness/embedded.md](docs/harness/embedded.md)。

## 你的数据

一个文件夹，在你的电脑上：`%APPDATA%\Zhiro\data`（Windows）、`~/Library/Application Support/Zhiro`（macOS）、`~/.local/share/zhiro`（Linux），或者你选的位置。不上传任何东西；联网的只有你订阅的招聘站、你选的 agent 或模型。

```bash
zhiro vault verify      # 数据完整吗
zhiro vault backup      # 随时备份一次（带检查）
zhiro vault rollback    # 回到上次升级前
```

详细：[docs/data.md](docs/data.md) · 接你自己的表格：[docs/data-sources.md](docs/data-sources.md)

## 文档

| | |
|---|---|
| [docs/data.md](docs/data.md) | 数据在哪；备份、升级、回退、搬到别的盘 |
| [docs/data-sources.md](docs/data-sources.md) | 把你自己的表格（飞书多维表格、CSV）接成每天更新的岗位来源 |
| [docs/harness/](docs/harness/) | Claude Code、Codex、WorkBuddy、DeepSeek（dsh）、其他 MCP 客户端 |
| [docs/contrib/](docs/contrib/) | 架构与设计决定（给贡献者） |

## 参与

欢迎报 bug、推荐要支持的招聘站、提 PR，见 [CONTRIBUTING.md](CONTRIBUTING.md)。加一个招聘站 = 一个文件加一个测试（[怎么加](apps/daemon/src/data/readers/README.md)）。安全问题请私下报告（[SECURITY.md](SECURITY.md)）。

## 许可

[MIT](LICENSE)。Moka 读取器包含来自 [career-ops](https://github.com/career-ops-hq/career-ops) 的三个文件（MIT）。
