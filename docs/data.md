# 你的数据：在哪、怎么备份、升级和回退

Zhiro 只在你自己的电脑上存数据，全部放在一个**数据文件夹**里。程序和数据分开：重装、升级程序都不动它。

## 在哪

第一次启动时会问一句放哪（直接回车用默认）。默认位置：

| 系统 | 默认 |
|---|---|
| Windows | `%APPDATA%\Zhiro\data` |
| macOS | `~/Library/Application Support/Zhiro` |
| Linux | `$XDG_DATA_HOME/zhiro`（没设就是 `~/.local/share/zhiro`） |

用过 JobOS（改名前）的：原来的 `%APPDATA%\JobOS\vault` 照用，不用搬。

**指定别的位置**，任选一种：

- `zhiro vault use <文件夹>`：以后都用它（新的空文件夹，或已有的职路数据文件夹）
- 启动时 `zhiro --data <文件夹>`（只这一次）
- 环境变量 `ZHIRO_DATA=<文件夹>`
- 已经在用、想**整体搬到别的盘**：设置页「数据」→「换个位置」，或 `zhiro vault move <空文件夹>`，然后重启 Zhiro。搬家是整体复制、逐个文件核对、全对才切换；旧的一份留着，由你自己删。

Zhiro 记住你选的位置（系统配置目录里的 `zhiro/data-dir`，不在数据文件夹里）。那个位置暂时打不开（比如移动硬盘没插），Zhiro 会说清楚并停下，**不会**在别处新建一份空数据。

## 里面有什么

| | |
|---|---|
| `jobos.db` | 岗位库、你的关注和申请、画像卡片、确认卡、调研记录（文件名沿用旧名） |
| `config/jobos.yaml` | 设置和岗位订阅 |
| `config/.daemon-token` | 你的钥匙（打开界面用）；`.agent-token` 是给你自己的 agent 用的 |
| `resume/`、`research/`、`profile/`、`submissions/`… | 你的简历、调研报告、材料、网申留档 |
| `backups/` | 备份 |
| `agent/` | 给 Claude Code / Codex / WorkBuddy 打开的工作目录（每次启动重写） |

不要手改 `jobos.db`；要改什么，在界面里或让你的 agent 用工具改。

## 备份

- 设置页「备份」或 `zhiro vault backup`：一份自带完整性检查的数据库副本，加一份去掉密钥的设置。只留最近 5 份和 1 份一周前的。Zhiro 在跑也能备份。
- 带到另一台电脑：`zhiro vault export [文件.zip]`（数据库、设置去掉密钥、你的文件；不含钥匙、登录状态），到那边 `zhiro vault import 文件.zip`（先停掉 Zhiro）。

## 检查

```
zhiro vault verify          # 完整检查（几秒）
zhiro vault verify --quick  # 快速检查
```

只读，Zhiro 在跑也能用。报「检查通过」就没事；有问题会逐条说。提 issue 时贴这个输出（不含个人信息）。

## 升级

升级程序（`npm i -g @mazjq/zhiro@latest`，或再跑一次安装脚本）后第一次启动，如果新版本要改数据库的结构，Zhiro 会：

1. **不碰原来的库**，先复制一份；
2. 在复制品上升级；
3. 核对：每张表的条数一样，你的关注、申请、画像卡片、确认卡、简历逐条对得上，结构完整；
4. 全对才换上，原来那份原样放进 `backups/pre-v<旧>-v<新>-<时间>.db`。

中途出任何错（包括断电、被关掉），原来的库都没被改过，下次启动会收拾干净。空间不够（要大约库的 2 倍）会直接说，不升级。

## 回到升级前

```
zhiro vault rollback        # 用最近一次升级前的那份（先停掉 Zhiro）
```

它先核对备份没被改过，再把它**复制**回来（备份本身留着），换下来的库也留在 `backups/`。最后告诉你这份数据配哪个版本：装回那个版本再启动（`npm i -g zhiro@<版本>`）。

先回退、再装旧版本。顺序反了的话，旧版本会说「数据是更新的版本写的」并拒绝打开——这是保护，不是坏了。
