# depseek

一次扫描某个目录下所有 `package.json`（不要求是 monorepo），列出**跨项目的版本冲突**和**可用更新**，并按指定的版本写法批量更新。参数、短选项、JSON 输出和 `.ncurc` 配置与 [ncu](https://github.com/raineorshine/npm-check-updates) 兼容，可以直接替换（见[从 ncu 迁移](#从-ncu-迁移)）。

[![npm](https://img.shields.io/npm/v/depseek.svg)](https://www.npmjs.com/package/depseek)
[![CI](https://github.com/ropean/depseek/actions/workflows/ci.yml/badge.svg)](https://github.com/ropean/depseek/actions/workflows/ci.yml)

- **默认只读**：不加 `-u` 只显示结果，绝不改文件
- **默认安全**：写入前显示 diff，`--dry-run` 只看 diff；写入要求 git 工作区干净，并总会备份，`depseek undo` 一键恢复
- **保留原格式**：只替换版本号字符串，缩进、换行符、字段顺序、文件末尾换行全部不变
- **包管理器无关**：只读写 `package.json`，install 按各项目的 lock 文件调用 bun / pnpm / npm / yarn（没有 lock 时默认 bun）

完整需求见 [docs/SPEC.md](./docs/SPEC.md)。

## 安装

```sh
npm i -g depseek     # 或 pnpm add -g / bun add -g
npx depseek --help   # 不安装直接用
```

需要 Node.js ≥ 22。

## 快速上手

```sh
depseek                                   # 当前目录递归检查更新（只读）
depseek tree ~/projects                   # 按树形结构列出 package.json 所在位置
depseek conflicts                         # 同一依赖在不同项目里版本不一致
depseek ~/projects --level patch,minor -u # 只升 patch 和 minor
depseek up react@19.0.0 react-dom@19.0.0  # 所有项目都改成指定版本
depseek -i --format caret                 # 交互选择，写成 ^x.y.z
depseek conflicts --fix --align highest   # 对齐到已有的最高版本
depseek format --to exact --from-lock     # 只改写法：^1.2.3 → 实际安装的 1.2.7
depseek undo                              # 恢复上一次写入
```

## 命令

| 命令                                 | 作用                                                       |
| ------------------------------------ | ---------------------------------------------------------- |
| `depseek [dir...]` / `check`         | 列出可用更新（只读）；`-u` 写入，`-i` 交互选择             |
| `depseek up [pkg[@ver]...] [dir...]` | 更新，等同 `check -u`；`pkg@ver` 把所有项目改成该版本/范围 |
| `depseek conflicts [pkg...]`         | 列出版本冲突；`--fix` 统一                                 |
| `depseek format --to <fmt>`          | 只改版本写法，不升级；`--from-lock` 用 lock 里的实际版本   |
| `depseek ls [pkg...]`                | 某个依赖在哪些项目里、各用什么版本（及实际安装版本）       |
| `depseek tree [dir...]`              | 以目录树显示扫描到的 package.json（名称、lock、依赖数）    |
| `depseek undo [id] [--list]`         | 恢复上一次（或指定）写入前的状态                           |
| `depseek doctor [--test <cmd>]`      | 逐个升级 → install → 跑测试，失败的回退，最后报告          |
| `depseek init`                       | 生成 `depseek.config.json` 模板                            |

### 扫描范围

默认从当前目录递归查找，跳过 `node_modules`、`.git`、`dist`、`build`、`.next`、`.output`、`.wrangler`、`.turbo`、`coverage`、`.cache` 以及 `fixtures`、`templates`、`examples` 等目录，并遵守 `.gitignore`。

```sh
depseek tree                    # 先确认扫描范围
depseek --list-files            # 只列出文件路径（加 --tree 显示为树）
depseek a/ b/ --depth 2 --exclude legacy --include 'apps/**'
depseek --no-gitignore --no-default-ignore --follow-symlinks
```

`depseek tree` 示例输出：

```
. (5 package.json)  mono  2 deps  [workspace root, private, bun.lock]
├── packages/ui  @m/ui  2 deps  [workspace]
├── apps/
│   ├── api  @m/api  3 deps  [workspace]
│   └── web  @m/web@1.0.0  4 deps  [workspace]
└── libs  ✖ invalid package.json: Expected double-quoted property name …
    └── deep/nested/x  x  3 deps
```

只有一个子目录的目录链会被合并显示（`deep/nested/x`）；JSON 解析失败的文件以 ✖ 标出，不会中断扫描。`--ascii` 使用 ASCII 画线，`-o json` 输出机器可读的列表。

### 检查更新

```
express     4.19.2   →  5.3.0   ▲ major  1 month ago   apps/api
react       ^18.3.1  →  19.3.1  ▲ major  4 weeks ago   apps/web
prettier    ^3.3.0   →  3.10.1  △ minor  1 day ago     .
react       ^19.0.0  →  19.3.1  △ minor  4 weeks ago   libs/x, packages/ui

patch 0 · minor 2 · major 2  in 4 files
```

- 同一依赖跨项目合并为一行（`--group-by package`，默认）；`--group-by project` 按文件分块，`--group-by level` 按级别分块
- 目标版本只对变化的部分着色；`0.x` 的 minor 视为破坏性（major）；prerelease 单独着色
- 每个级别同时带符号（▲ △ · β），不看颜色也能分辨
- 底部列出 deprecated 的在用版本、无法检查的依赖（git / URL）、被配置忽略的依赖
- `--audit` 查询 [OSV](https://osv.dev) 标出已知漏洞及修复版本

### 写入格式 `--format` 与目标版本 `--target`

| `--format`      | 写入       |     | `--target`       | 含义                                 |
| --------------- | ---------- | --- | ---------------- | ------------------------------------ |
| `exact`（默认） | `1.4.2`    |     | `latest`（默认） | registry 的 `latest` 标签            |
| `tilde`         | `~1.4.2`   |     | `minor`          | 不跨主版本                           |
| `caret`         | `^1.4.2`   |     | `patch`          | 只升 patch                           |
| `preserve`      | 沿用原前缀 |     | `semver`         | 当前范围允许的最高版（写法保持不变） |
| `gte`           | `>=1.4.2`  |     | `greatest`       | 最高版本号，包含 prerelease          |
| `x-range`       | `1.x`      |     | `newest`         | 最近发布的版本                       |
|                 |            |     | `@<tag>`         | 指定 dist-tag，如 `@next`            |

可以在配置里按依赖类型设置格式：`"format": { "prod": "exact", "peer": "caret" }`。

特殊写法：`workspace:` / `file:` / `link:` / `portal:` / `catalog:` 跳过；git / URL 列为“无法检查”；`npm:pkg@x` 别名按真实包名查询、写回保留别名；`*` / `latest` 默认跳过（`--pin-wildcards` 改为具体版本）；`overrides` / `resolutions` / `pnpm.overrides` 用 `--dep overrides` 参与；`packageManager` 用 `--dep packageManager` 检查。

### 冲突检测

```
react  ● high · major versions differ
  ^19.0.0  ×2  libs/x, packages/ui (dev)
  ^18.3.1  ×1  apps/web
  → 19.0.0 (within 19.x; --allow-major for all)

zod  ◐ medium · minor / patch differ
typescript  ○ low · written differently
lodash  ℹ hint · dependencies vs devDependencies

3 dependencies have conflicts, 1 across major versions
```

还会根据 `node_modules` 报告已安装包的 **peer 依赖不满足**。`--fix --align highest|lowest|most-used|latest|<version>` 统一版本；默认不跨主版本（每条主版本线各自对齐），`--allow-major` 或 `-i` 逐个确认后才跨。

### 过滤（check / conflicts / up / format / ls 通用）

| 参数                            | 说明                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| `-f, --filter` / `-x, --reject` | 包名，支持逗号分隔、通配符（`@types/*`）和 `/regex/`                                       |
| `--dep <types>`                 | `prod,dev,peer,optional,overrides,packageManager`，默认 `prod,dev,optional,packageManager` |
| `--project <glob>`              | 只处理路径或 `name` 匹配的 package.json                                                    |
| `--level <levels>`              | `patch,minor,major,prerelease`                                                             |
| `-c, --cooldown <period>`       | 忽略最近发布的版本：`7`（天）、`7d`、`12h`、`30m`（防止升到刚发布就被撤回/投毒的版本）     |
| `-m, --minimal`                 | 当前范围已经允许的版本不算更新（`^1.2.0` 时不提示 1.5.0）                                  |

### 交互模式 `-i`

按 major / minor / patch 分组，patch 和 minor 默认勾选。`空格` 勾选、`a` 全选、`p` / `m` / `M` 按级别切换、`/` 搜索、`→` 展开（逐个项目勾选、看警告和 changelog 链接）、`v` / `V` 切换到其他版本、`o` 打开 changelog、`回车` 确认（会显示将修改的依赖数和文件数）。

### 写入之后

- `--install always|prompt|never`（默认 `prompt`）：按每个项目的 lock 文件识别包管理器，workspace 成员在根目录 install，并行执行
- `--commit`：提交改动的 package.json 和 lock 文件；`--commit=level` 按 patch / minor / major 分批写入、install、提交
- `--no-git-check`：允许改动有未提交修改的文件（仍会备份）

### 写入前的检查

- **关联包一起升级**：内置 `react` + `react-dom`、Vue、Angular、vitest、typescript-eslint 等分组，组内升到同一版本；`groups` 配置自定义
- **@types 跟随**：`@types/react` 保持与 `react` 同一主版本；`@types/node` 跟随 `runtime.node` / `engines.node`，否则不跨当前主版本
- **peer 依赖预检**：升级后的版本要求的 peer 不满足、或其他包对它的 peer 要求不满足时警告
- **engines**：新版本要求更高的 Node / Bun 时警告
- **许可证变化**：如 MIT → BSL 时警告
- **已废弃**：目标版本不会选 deprecated 版本；在用的 deprecated 版本会列出

## 从 ncu 迁移

把 `ncu` 换成 `depseek` 即可：ncu 的长选项（含 camelCase 写法，如 `--errorLevel`）、短选项、`--jsonUpgraded` 等 JSON 输出和 `.ncurc` / `.ncurc.{json,yml,yaml,js,cjs,mjs}` 配置都能直接用。区别是 depseek **默认递归扫描**（相当于 ncu 的 `--deep` / `--workspaces --root`），且默认写成精确版本（`--format preserve` 保留原前缀，与 ncu 一致）。

| ncu                                                                     | depseek                                  | 说明                                                     |
| ----------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------- |
| `ncu react "/^@types/"`                                                 | 同                                       | 位置参数：不是目录就当作包名过滤                         |
| `-u` `-i` `-t` `-f` `-x` `--dep`                                        | 同                                       |                                                          |
| `-c, --cooldown 7d / 12h`                                               | 同                                       |                                                          |
| `-m, --minimal`                                                         | 同                                       |                                                          |
| `-e, --errorLevel 2`                                                    | 同（= `--error-on outdated`）            | 还可以 `--error-on major,deprecated,vulnerable…`         |
| `-d, --doctor` `--doctorTest` `--doctorInstall`                         | 同（= `depseek doctor`）                 |                                                          |
| `-j, --jsonAll` `--jsonDeps` `--jsonUpgraded`                           | 同，单个项目输出对象，多个项目按文件分组 | 和 ncu `--workspaces` 的结构一致                         |
| `-p, --packageManager bun`                                              | 同                                       | 强制所有 install 使用该包管理器                          |
| `-r, --registry <url>`                                                  | 同                                       | 默认读 `.npmrc` / `bunfig.toml`                          |
| `-s, --silent` / `-l, --loglevel`                                       | 同                                       |                                                          |
| `--deep` / `-w, --workspaces` / `--root`                                | 默认行为                                 | `--no-root` 排除 workspace 根                            |
| `--workspace <name>` / `--packageFile <glob>`                           | 同                                       | 也可以用 `--project`                                     |
| `--removeRange`                                                         | 同（= `--format exact`）                 |                                                          |
| `--format group,time,repo…`                                             | 接受（默认已显示时间、按级别标注）       | `lines`、`ownerChanged` 暂不支持                         |
| `--retry` `--timeout` `--concurrency` `--cacheClear`                    | 同                                       |                                                          |
| `-g, --global`、`--peer`、`--enginesNode`、`--pre`、`--filterVersion` … | 暂不支持，给出明确提示                   | `--peer` / `--enginesNode` 在 depseek 里是警告而不是过滤 |

**depseek 原来的短选项改成了 ncu 的含义**：分组用 `--group-by`、配置文件用 `--config`、项目过滤用 `--project`、级别用 `--level`、递归用 `--recursive`（都只保留长选项）。

## CI

```sh
depseek --error-on major,deprecated          # 有 major 更新或用了废弃版本时 exit 1
depseek conflicts --error-on conflicts       # 有版本冲突时 exit 1
depseek --error-on vulnerable                # 有已知漏洞（自动开启 --audit）
depseek -e 2                                 # ncu 写法：有任何可升级时 exit 1
depseek -o markdown > deps.md                # 直接贴到 PR 描述
depseek -o json | jq '.summary'
```

`--error-on` 可选：`outdated`、`major`、`deprecated`、`peer`、`conflicts`、`vulnerable`。

## 配置

`depseek init` 生成 `depseek.config.json`（也支持 `.depseekrc.json`、`.depseekrc`、package.json 的 `"depseek"` 字段，从当前目录向上查找到 git 根目录）。所有 CLI 参数都可以写在配置里，CLI 优先。

已有的 `.ncurc*`（当前目录 → git 根目录 → home）也会自动读取，作为 ncu 选项的默认值；不认识或不支持的键会提示后忽略，`--no-ncurc` 关闭。

```jsonc
{
  "format": { "prod": "exact", "dev": "exact", "peer": "caret" },
  "cooldown": 3,
  "install": "prompt",
  "theme": { "name": "default", "colors": { "major": "red bold", "minor": "#33" } },
  "scan": { "exclude": ["legacy"] },
  "ignore": [{ "name": "eslint", "reason": "flat config 迁移中" }],
  "pin": { "typescript": { "range": "~5.6.0", "reason": "等工具链支持" } },
  "ignoreVersions": [{ "spec": "vite@6.1.0", "reason": "HMR 有 bug" }],
  "groups": [["@tanstack/react-query", "@tanstack/react-query-devtools"]],
  "conflicts": {
    "ignore": ["@types/node"],
    "groups": [{ "name": "legacy", "projects": ["legacy/*"] }],
  },
  "runtime": { "node": "22.12.0" },
  "gitCheck": true,
  "audit": false,
}
```

### Registry

读取 `~/.npmrc`、从 git 根目录到当前目录的 `.npmrc` 和 `bunfig.toml`（`[install] registry`、`[install.scopes]`），支持私有 scope 和 `_authToken` / `_auth` / `username` + `_password`，以及 `${ENV}` 变量。`-r, --registry <url>` 临时覆盖默认 registry。同一个包只查询一次，默认 16 并发（`--concurrency`），失败重试 3 次（`--retry`），单个请求超时 60 秒（`--timeout <ms>`），结果缓存 10 分钟（`--no-cache` 强制刷新、`--cache-clear` 清空，`cacheTtl` 配置，`DEPSEEK_CACHE_DIR` 改目录）。

### 颜色主题

`--theme default|dark|light|colorblind|mono`。`colorblind` 用蓝/橙配色，`mono` 只用粗体和符号。遵守 `NO_COLOR` / `FORCE_COLOR`，输出到管道或文件时自动关闭颜色。

## 编程接口

```ts
import {
  scan,
  analyze,
  findConflicts,
  RegistryClient,
  loadRegistryConfig,
  buildSelection,
  selectEntries,
} from 'depseek';

const { projects } = await scan({ roots: ['.'] });
const selection = buildSelection({}, {});
const entries = selectEntries(projects, selection);
console.log(findConflicts(entries));

const client = new RegistryClient({ config: loadRegistryConfig(process.cwd()) });
const { updates } = await analyze(projects, entries, { client, selection, target: 'minor' });
```

## 开发

见 [DEVELOPMENT.md](./DEVELOPMENT.md)。

## License

MIT
