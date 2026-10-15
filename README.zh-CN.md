<div align="center">

# Zhiro · 职路

一个跑在你自己电脑上的开源求职工具，配合你已经在用的 AI agent。

[English](README.md) | 简体中文

[![CI](https://github.com/mazjq/zhiro/actions/workflows/ci.yml/badge.svg)](https://github.com/mazjq/zhiro/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@mazjq/zhiro)](https://www.npmjs.com/package/@mazjq/zhiro)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

我做职路，是因为自己在找工作。投简历不难，难的是知道往哪投：哪些岗位真的对口，差的那几项值不值得补，一家公司在招聘启事之外到底怎么样。

职路把这些放在一处：你的画像、每天更新的岗位库、公司的财报和公告。投出去以后的进度、邮件、网申，它也一起管。它配合 Claude Code、Codex、WorkBuddy 或任何支持 MCP 的客户端用。先为国内校招做，社招也能用。

![职路：按你的画像排好的岗位](docs/assets/jobs.png)

<sub>截图里的公司、岗位和数字都是虚构的。</sub>

## 为什么用职路

### 1. 机会缺口：还差哪几项

一般的筛选会把「不符合」的岗位直接拿掉，你也就不知道自己差在哪。职路把和你方向相关的岗位都留着，挑出你画像里还看不出来的要求，按能力归类，数清每一项卡住了几个岗位、几家公司。

大多数缺口只是画像里没写，不等于你不会。点「我会」或「没做过」，相关岗位会重新匹配。下图里，C++ 出现在 4 个岗位的要求里，ROS 出现在 2 个。

![机会缺口：每项能力卡住了几个岗位](docs/assets/gaps.png)

### 2. 看公司本身

招聘启事大同小异。想知道一家公司怎么样，要看它的经营和公告。职路给你的 agent 这些数据工具：

- 上市公司（A 股、港股、美股、新三板）近三年的营收、净利、增速、毛利率、研发投入、员工数、人均支付给职工的现金。
- 一年内的公告：股权激励和员工持股、扩产、政府补助、专精特新认定、大股东减持。专精特新公司常是产业链里不好替代的那一环。
- 行业层面：一个板块有哪些上市公司，券商最近出了哪些研报，美国劳工统计局（BLS）的岗位薪资。

让 agent 调研一个行业或一家公司，它会拿这些数据加上网搜索写一份报告。每条结论标了依据，职路再核对句子里的数字和取到的数据对不对得上。报告提到的公司会和岗位库对上，在招的岗位点一下就能看。

![调研报告：要点、依据、提到的公司](docs/assets/research.png)

<img src="docs/assets/company-intel.png" alt="一家公司的情况卡：营收、研发、人均职工现金" width="520">

### 3. 岗位和截止日期

岗位库每天自动更新。它读公司自己的招聘站（Moka、北森、飞书招聘、大易、前程无忧、智联校园、国聘等），也读你自己的表格（飞书多维表格、CSV）。几个来源给的截止日期不一样时，职路会对照，每个日期都写着从哪来、核实过没有。

匹配按你的画像来。画像是一张张小卡片，教育、技能、项目、偏好各一类，随时能改。

| 今日：快截止的、等你拍板的 | 求职资料：匹配、选简历、网申都从这里取值 |
|---|---|
| ![今日](docs/assets/today.png) | ![求职资料](docs/assets/profile.png) |

### 4. 投递以后

每份申请的进度都记着（关注、准备、已投、笔试面试、结果），快到日子会提醒。收件箱读招聘邮件，认出笔试和面试邀请，对上是哪份申请，再问你要不要更新。

网申可以交给它填。它用一个单独的 Chrome 档案，按画像和合适的那份简历把表填好，停在提交前。提交按钮你自己点。

| 投递：每一步进度，岗位要求原文随手可查 | 收件箱：招聘邮件变成下一步 |
|---|---|
| ![投递](docs/assets/pipeline.png) | ![收件箱](docs/assets/inbox.png) |

### 5. agent 能做什么，数据放在哪

agent 直接做的只有能撤销的事。有影响的操作会变成一张确认卡，等你点。登录和密码它碰不到。

数据都在你电脑上的一个文件夹里。升级先在副本上做，核对无误才换上；出了问题，一条命令回到升级前。

## 安装

**装了 Node 22.13 或更新？**

```bash
npx @mazjq/zhiro                 # 试一下
npm i -g @mazjq/zhiro && zhiro   # 长期用（装好后命令叫 zhiro）
```

**没有 Node？** 一行命令装好。脚本自带一份官方 Node（按 nodejs.org 的校验和核对过），不动你系统里的东西：

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
