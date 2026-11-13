# 依赖扫描与版本统一 CLI — 需求规格

Nov 13, 2026 · @Wei Guo

## 概述

一个 CLI 工具，一次扫描某个目录下所有 package.json（非 monorepo 也可以），列出版本冲突和可用更新，并能按指定的版本写法批量更新。交互方式参考 ncu，再加上 ncu 没有的跨项目冲突检测和统一功能。命令名为 `depseek`。

**设计原则**

- **默认只读**：不加 `-u` 只显示结果，绝不改文件。
- **默认安全**：写文件前先显示 diff；支持 `--dry-run`；改之前做备份或要求 git 工作区干净。
- **保留原格式**：写回时保持原来的缩进、换行符、字段顺序和文件末尾换行，只改版本号字符串。
- **包管理器无关**：只读写 package.json，install 交给用户选择的包管理器（默认识别 bun）。
- **对 ncu 用户零学习成本**：长短参数、JSON 输出、`.ncurc` 配置与 ncu 兼容，`ncu` 换成 `depseek` 即可（见 README「从 ncu 迁移」）。

**与 ncu 的主要区别**

| 方面              | ncu               | 本工具                           |
| ----------------- | ----------------- | -------------------------------- |
| 多个 package.json | `--deep` 逐个显示 | 汇总视图，同一依赖跨项目合并显示 |
| 版本冲突          | 不检测            | 核心功能                         |
| 写入格式          | 保留原前缀        | 可统一指定 exact / \~ / ^ 等     |
| 统一版本          | 不支持            | 一条命令对齐所有项目             |

## 扫描

默认从当前目录递归查找所有 package.json。

**你提出的**

- 指定目录：`depseek [dir...]`，默认 `.`，可以传多个。
- 是否递归：默认递归；`--no-recursive` 只看该目录本身。

**补充**

- **深度限制**：`--depth <n>`，防止扫到太深的目录。
- **默认忽略**：`node_modules`、`.git`、`dist`、`build`、`.next`、`.output`、`.wrangler`、`.turbo`、`coverage`、`.cache`。
- **遵守 .gitignore**：默认开启，`--no-gitignore` 关闭。可以自动排除生成的文件和临时目录。
- **自定义包含/排除**：`--include <glob>`、`--exclude <glob>`，可重复使用。
- **不跟随符号链接**：默认不跟随，避免循环和重复扫描。
- **跳过模板和测试夹具**：比如 `fixtures/`、`templates/`、`examples/` 里的 package.json 往往不该动，建议在默认忽略列表里可配置。
- **容错**：JSON 解析失败的文件报警告并跳过，不中断整个扫描。
- **识别项目信息**：每个 package.json 记录其 `name`、相对路径、旁边的 lock 文件类型（bun.lock / package-lock.json / pnpm-lock.yaml / yarn.lock），用于显示和之后的 install。
- **识别 workspace**：如果某个 package.json 有 `workspaces` 字段，标记其子包，并把 `workspace:*` 这类内部依赖排除在更新之外。
- **扫描结果摘要**：开头显示“扫描到 N 个 package.json，共 M 个不同依赖”；`--list-files` 只列出找到的文件，用来确认扫描范围对不对。
- **树形列出位置**：`depseek tree [dir...]`（或 `--list-files --tree`）按目录树显示每个 package.json 的位置，并附带 `name@version`、依赖数、lock 文件、workspace 角色；只有一个子目录的目录链合并显示（如 `deep/nested/x`），解析失败的文件用 ✖ 标出。`--ascii` 用 ASCII 画线，`-o json` 输出列表。

```
. (5 package.json)  mono  2 deps  [workspace root, private, bun.lock]
├── packages/ui  @m/ui  2 deps  [workspace]
├── apps/
│   ├── api  @m/api  3 deps  [workspace]
│   └── web  @m/web@1.0.0  4 deps  [workspace]
└── libs  ✖ invalid package.json
    └── deep/nested/x  x  3 deps
```

## 冲突检测

`depseek conflicts` 列出同一个依赖在不同 package.json 里版本不一致的情况，按依赖名分组显示。

**冲突类型**

| 类型            | 例子                                           | 严重程度   |
| --------------- | ---------------------------------------------- | ---------- |
| 主版本不同      | A 用 `react@^18.3.1`，B 用 `react@^19.0.0`     | 高（红色） |
| 次版本/补丁不同 | A 用 `zod@^3.22.0`，B 用 `zod@^3.24.1`         | 中（黄色） |
| 写法不同        | A 用 `~5.6.2`，B 用 `5.6.2`                    | 低（灰色） |
| 依赖类型不同    | A 放在 dependencies，B 放在 devDependencies    | 提示       |
| peer 不满足     | 安装的版本不满足某个包的 peerDependencies 范围 | 高（红色） |

**显示方式**

- 每个冲突依赖一组，列出各个版本及使用它的项目路径，版本按使用次数从多到少排。
- 标出建议的统一目标（默认是现有的最高版本）。
- 底部汇总：X 个依赖有冲突，其中 Y 个跨主版本。

**统一（fix）**

`depseek conflicts --fix` 把每个冲突依赖对齐到同一个版本，目标可选：

- `--align highest`（默认）：对齐到各项目中已有的最高版本
- `--align lowest`：对齐到最低版本，最保守
- `--align most-used`：对齐到使用最多的版本
- `--align latest`：直接对齐到 registry 上的最新版
- `--align <version>`：只用于单个包，如 `depseek conflicts react --fix --align 19.0.0`

默认不跨主版本对齐，跨主版本需要加 `--allow-major` 或在交互模式中逐个确认。配置里可以声明“允许不一致”的依赖或项目分组（见配置文件）。

## 检查更新

`depseek check`（不带子命令时的默认行为）列出可用更新，按升级级别分组并着色。

**更新级别与默认配色**

| 级别         | 含义                                     | 默认颜色    |
| ------------ | ---------------------------------------- | ----------- |
| major        | 主版本变化，可能有破坏性改动             | 红色        |
| minor        | 次版本，新增功能                         | 青色        |
| patch        | 补丁，修 bug                             | 绿色        |
| 0.x 的 minor | 如 `0.3 → 0.4`，按 semver 惯例视为破坏性 | 红色        |
| prerelease   | beta / rc / canary                       | 品红色      |
| 已废弃       | 当前或目标版本被 deprecated              | 黄色 + 标记 |

**输出内容**

- 每行：包名、当前范围、→、目标版本、级别、发布时间（如“3 天前”）。
- 目标版本只对变化的部分着色，如 `1.2.3 → 1.`**`4.0`**，一眼看出改了哪一位。
- 两种分组视图：`--group-by package`（默认，同一依赖跨项目合并为一行，后面列出影响的项目）和 `--group-by project`（按 package.json 分块，类似 ncu --deep）。
- `--group-by level`：按 major / minor / patch 分块显示。
- 底部统计：patch X 个，minor Y 个，major Z 个。

**颜色主题**

- 内置主题：`default`、`dark`、`light`、`colorblind`（红绿色盲友好，用蓝/橙配色加符号区分）、`mono`（无颜色，只用粗体和符号）。
- `--theme <name>` 切换；配置文件里可以自定义每个级别的颜色。
- 除了颜色，每个级别还带一个文字标签或符号，保证不看颜色也能分辨。
- 遵守 `NO_COLOR` / `FORCE_COLOR` 环境变量，输出到管道或文件时自动关闭颜色。

**版本查询**

- 从 registry 并发拉取元数据，并发数可配（`--concurrency`，默认 16）。
- 同一个包只查一次，即使它出现在很多个 package.json 里。
- 本地缓存结果，默认 10 分钟有效，`--no-cache` 强制刷新。
- 读取 `.npmrc` 和 `bunfig.toml` 里的 registry 与私有 scope 配置，支持带 token 的私有源。

## 更新

更新由两个独立的选择组成：**升到哪个版本**（target）和**版本号写成什么样**（format）。`depseek -u` 或 `depseek up` 执行写入。

**写入格式（`--format`）**

| 格式            | 写入结果        | 说明                                      |
| --------------- | --------------- | ----------------------------------------- |
| `exact`（默认） | `1.4.2`         | 你提出的默认方式，锁定具体版本            |
| `tilde`         | `~1.4.2`        | 允许后续 patch                            |
| `caret`         | `^1.4.2`        | 允许后续 minor 和 patch                   |
| `preserve`      | 沿用原前缀      | 原来是 `^` 就还是 `^`，和 ncu 行为一致    |
| `gte`           | `>=1.4.2`       | 少用，适合库的 peerDependencies           |
| `x-range`       | `1.x` / `1.4.x` | 按原来的精度保留通配符，只提升主/次版本号 |

建议支持**按依赖类型设置不同格式**，比如应用的 dependencies 用 `exact`，库的 peerDependencies 用 `caret`。配置里写 `format: { dependencies: "exact", peerDependencies: "caret" }`。

**目标版本（`--target`，参考 ncu）**

| 目标             | 含义                                         |
| ---------------- | -------------------------------------------- |
| `latest`（默认） | registry 上 `latest` 标签的版本              |
| `minor`          | 不跨主版本，升到当前主版本内最新             |
| `patch`          | 只升 patch                                   |
| `semver`         | 只升到当前范围允许的最高版（不改变范围含义） |
| `greatest`       | 最高版本号，包含 prerelease                  |
| `newest`         | 最近发布的版本，不管版本号大小               |
| `@<tag>`         | 指定 dist-tag，如 `@next`、`@beta`           |

**更新为特定版本**

- `depseek up react@19.0.0`：把所有项目里的 react 都更新为 19.0.0（按 `--format` 写前缀）。
- `depseek up react@^19`：解析为满足范围的最新版本。
- 可以一次传多个：`depseek up react@19.0.0 react-dom@19.0.0`。
- 写入前校验该版本在 registry 上确实存在。

**只改格式不升级**

`depseek format --to exact`：只把现有的 `^1.2.3`、`~1.2.3` 改写成 `1.2.3`（或反向），版本号不变。统一写法时很有用。改为 exact 时，可选用 lock 文件里实际安装的版本（`--from-lock`），而不是范围的下限。

**特殊版本写法的处理**

| 写法                                       | 默认处理                                                     |
| ------------------------------------------ | ------------------------------------------------------------ |
| `workspace:*`、`file:`、`link:`、`portal:` | 跳过                                                         |
| git / GitHub URL、tarball URL              | 跳过，列为“无法检查”                                         |
| `npm:pkg@x` 别名                           | 按真实包名查询，写回时保留别名形式                           |
| `*`、`latest`、`x`                         | 默认跳过，`--pin-wildcards` 时改为具体版本                   |
| `catalog:`                                 | 跳过（如果以后用 bun workspaces，可以改为更新 catalog 本身） |
| `overrides` / `resolutions`                | 也参与检查和更新，但单独标记                                 |
| `engines`、`packageManager`                | 可选检查（如 bun 版本），默认关闭                            |

## 过滤与选择

所有命令（check / conflicts / up）共用同一套过滤参数。

- **按包名**：`-f, --filter <pattern>` 只处理匹配的包；`-x, --reject <pattern>` 排除。支持通配符（`@types/*`）、逗号分隔和 `/regex/`，与 ncu 一致。
- **按依赖类型**：`--dep prod,dev,peer,optional,overrides,packageManager`，默认 `prod,dev,optional,packageManager`（与 ncu 一致；peer 默认不动，因为它是给使用者的约束）。
- **按项目**：`--project <glob>` 只处理匹配路径或 `name` 的 package.json。
- **按级别**：`--level patch,minor` 只显示/更新这些级别，比如日常只自动升 patch。
- **按发布时间**：`-c, --cooldown <period>`（`7`、`7d`、`12h`、`30m`）忽略刚发布的版本，避开刚发布就被撤回或被投毒的版本（见补充功能）。

**交互模式（`-i`）**

- 列表按 major / minor / patch 分组，默认勾选 patch 和 minor，major 默认不勾。
- 快捷键：空格勾选，`a` 全选，`p` / `m` / `M` 按级别全选，`/` 搜索。
- 选中某一行可以展开：看影响的项目列表、选择其他版本（不一定是最新）、打开 changelog 链接。
- 同一依赖在多个项目里合并为一行，可以展开后只勾选部分项目。
- 确认前显示将要修改的文件数和依赖数。

## 补充功能

下面是你没有提到、但在多项目依赖管理中常见且有用的功能，按建议优先级排序。

| 功能                    | 解决什么问题                                                                                                                 | 优先级 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------ |
| **更新后自动 install**  | 改完 package.json 后 lock 文件不同步。`--install always\|prompt\|never`，按每个项目的 lock 文件识别包管理器，并行执行        | P0     |
| **关联包一起升级**      | `react` 和 `react-dom`、`@types/react` 版本必须配套。内置常见分组，并支持配置 `groups`（如 `@tanstack/*`），组内升到同一版本 | P0     |
| **撤销（undo）**        | 更新后发现出问题。每次写入前备份所有被改的 package.json，`depseek undo` 一键恢复                                             | P0     |
| **Dry run / diff 预览** | 想先看看会改什么。`--dry-run` 输出统一 diff                                                                                  | P0     |
| **版本冷却期**          | 供应链攻击常在发布后几小时内被发现和撤回。`--cooldown 3` 不升到 3 天内发布的版本                                             | P1     |
| **已废弃提示**          | 用着已 deprecated 的包或版本却不知道。显示废弃信息及推荐替代                                                                 | P1     |
| **安全漏洞检查**        | 查 OSV / GitHub Advisory，标出当前版本有已知漏洞的依赖，并提示“升到哪个版本可修复”                                           | P1     |
| **忽略与锁定**          | 某些包故意不升级，或某个版本已知有 bug。配置 `ignore`、`pin`、`ignoreVersions`（如 `vite@6.1.0`），可加备注说明原因          | P1     |
| **peer 依赖预检**       | 升级 A 后不再满足 B 的 peerDependencies。写入前计算并警告                                                                    | P1     |
| **changelog 链接**      | 不知道 major 升级改了什么。从 repository 字段生成 GitHub Releases / CHANGELOG 链接；可选拉取 release 标题                    | P1     |
| **doctor 模式**         | 参考 ncu `--doctor`：逐个升级并运行测试命令，失败就回退该包，最后报告哪些可以安全升级                                        | P2     |
| **engines 兼容检查**    | 新版本要求更高的 Node / Bun。对照本地或配置里声明的运行时版本，不兼容则警告                                                  | P2     |
| **@types 版本跟随**     | `@types/node` 等应与实际运行时/主包的主版本一致，而不是无脑升到最新                                                          | P2     |
| **Git 集成**            | 要求工作区干净才能写入（可关）；`--commit` 按级别或分组自动提交，提交信息列出升级的包                                        | P2     |
| **报告导出**            | `--output json\|markdown`，markdown 可直接贴到 PR 描述里                                                                     | P2     |
| **许可证变化提醒**      | 新版本换了 license（如 MIT → BSL）时警告，对商业项目很重要                                                                   | P2     |
| **未使用依赖检测**      | package.json 里有但代码没 import 的依赖。工作量大，可以以后做或调用 knip                                                     | P3     |
| **包体积变化**          | 升级后依赖体积变大多少。对前端项目有用，但需要额外数据源                                                                     | P3     |

**更新执行流程**（整合上述功能后）

1. 扫描文件，读取配置和忽略规则
2. 并发查询 registry，应用 target、cooldown、分组规则
3. 检查 peer、engines、废弃、漏洞，收集警告
4. 显示结果（或进入交互选择）
5. 备份 → 按 format 写入 package.json，保留原格式
6. 按需在各项目内 install，可选运行测试和 git commit

## 命令与参数设计

子命令保持少而清晰；不带子命令时等同于 `check`，和 ncu 的习惯一致。

**子命令**

| 命令                            | 作用                                 |
| ------------------------------- | ------------------------------------ |
| `depseek [dir...]` / `check`    | 列出可用更新（只读）                 |
| `depseek up [pkg[@ver]...]`     | 更新，等同于 `check -u`              |
| `depseek conflicts`             | 列出版本冲突；`--fix` 统一           |
| `depseek format --to <fmt>`     | 只改版本写法，不升级                 |
| `depseek ls [pkg]`              | 某个依赖在哪些项目里、各用什么版本   |
| `depseek tree [dir...]`         | 按树形结构列出 package.json 所在位置 |
| `depseek doctor [--test <cmd>]` | 逐个升级并跑测试，失败回退           |
| `depseek undo`                  | 恢复上一次写入前的状态               |
| `depseek init`                  | 生成配置文件模板                     |

**常用参数**

| 参数                             | 默认值            | 说明                      |
| -------------------------------- | ----------------- | ------------------------- |
| `--recursive` / `--no-recursive` | 递归              | 是否递归扫描              |
| `--depth <n>`                    | 不限              | 递归深度                  |
| `--include` / `--exclude <glob>` | —                 | 扫描范围                  |
| `-u, --upgrade`                  | 关                | 写入文件                  |
| `-t, --target <t>`               | `latest`          | 目标版本策略              |
| `--format <f>`                   | `exact`           | 写入格式                  |
| `-f, --filter` / `-x, --reject`  | —                 | 按包名过滤                |
| `--dep <types>`                  | 含 packageManager | 依赖类型                  |
| `--level <levels>`               | 全部              | 只处理指定级别            |
| `-i, --interactive`              | 关                | 交互选择                  |
| `--group-by <g>`                 | `package`         | package / project / level |
| `-c, --cooldown <period>`        | 0                 | 冷却期                    |
| `--install <mode>`               | `prompt`          | 更新后是否 install        |
| `--dry-run`                      | 关                | 只显示 diff               |
| `--theme <name>`                 | `default`         | 颜色主题                  |
| `--output <fmt>`                 | `table`           | table / json / markdown   |
| `--error-on <cond>`              | —                 | 用于 CI，见下文           |
| `--concurrency <n>`              | 16                | registry 并发请求数       |
| `--no-cache`                     | —                 | 忽略本地缓存              |
| `--config <path>`                | 自动查找          | 指定配置文件              |

**示例**

```bash
depseek                               # 当前目录递归检查更新
depseek ~/projects --level patch,minor -u   # 只升 patch 和 minor
depseek up react@19.0.0 react-dom@19.0.0    # 所有项目升到指定版本
depseek -i --format caret             # 交互选择，写成 ^x.y.z
depseek conflicts --fix --align highest
depseek format --to exact --from-lock
depseek tree ~/projects               # 树形列出所有 package.json
```

## 实现状态

以下为 v0.0.1 的实现情况。

| 范围                                                                                                                        | 状态 | 说明                                                                          |
| --------------------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------- |
| 扫描（多目录、递归/深度、默认忽略、.gitignore、include/exclude、符号链接、容错、lock/workspace 识别、摘要、`--list-files`） | ✅   | 默认忽略列表可通过配置 `scan.ignore` 替换，`--no-default-ignore` 关闭         |
| 树形列出（`depseek tree`、`--list-files --tree`）                                                                           | ✅   |                                                                               |
| 冲突检测（主版本/次版本/写法/依赖类型/peer 不满足）与 `--fix --align`                                                       | ✅   | peer 不满足基于 `node_modules` 中的已安装版本                                 |
| 检查更新（级别着色、0.x、prerelease、废弃、变化部分高亮、三种分组、统计）                                                   | ✅   |                                                                               |
| 颜色主题（default / dark / light / colorblind / mono、自定义颜色、NO_COLOR / FORCE_COLOR）                                  | ✅   |                                                                               |
| 版本查询（并发、去重、10 分钟缓存、.npmrc / bunfig.toml、私有 scope 与 token）                                              | ✅   |                                                                               |
| 写入格式（6 种，按依赖类型配置）与目标版本（7 种）                                                                          | ✅   | 复杂范围（`>=1 <2`、`a \|\| b`）在 `preserve` 下改写为 `^`                    |
| `up pkg@ver`、校验版本存在、`format --to` / `--from-lock`                                                                   | ✅   | `--from-lock` 支持 node_modules、package-lock、bun.lock、pnpm-lock、yarn.lock |
| 特殊写法处理（workspace/file/link/portal/catalog/git/URL/别名/通配/overrides/packageManager）                               | ✅   | `engines` 字段不作为依赖检查，只用于兼容性警告                                |
| 过滤（`-f` / `-x` / `--dep` / `--project` / `--level` / `--cooldown`）                                                      | ✅   |                                                                               |
| 交互模式                                                                                                                    | ✅   |                                                                               |
| 自动 install、关联包分组、undo、dry-run/diff                                                                                | ✅   |                                                                               |
| 冷却期、废弃提示、OSV 漏洞检查、忽略与锁定、peer 预检、changelog 链接                                                       | ✅   | changelog 只生成链接，不拉取 release 标题                                     |
| doctor、engines 检查、@types 跟随、Git 集成、报告导出、许可证变化提醒                                                       | ✅   |                                                                               |
| 未使用依赖检测、包体积变化（P3）                                                                                            | ⏳   | 未实现，可配合 knip 等工具                                                    |
