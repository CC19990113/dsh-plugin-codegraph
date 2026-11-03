# dsh-plugin-codegraph

[English](README.md) | 中文

[![dshfind](https://dshfind.com/api/badge/CC19990113/dsh-plugin-codegraph?lang=zh)](https://dshfind.com/zh/plugins/CC19990113/dsh-plugin-codegraph?ref=badge)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(`dsh`)加上结构化代码检索能力。

装上之后,agent 多出两个工具:`codegraph` 和 `codegraph_index`。它能直接问"这个函数在哪定义的""谁调用了它""改了它会影响哪些地方""从 A 怎么走到 B",答案来自预先建好的符号索引,检索方法上比grep更快 消耗更小。

```sh
dsh plugin --profile <name> add dsh-plugin-codegraph
```

## 解决什么问题

Agent 改代码之前,总要先搞清楚代码之间的关系。但它手上的工具在这件事上都不好使:

- **grep** 会把注释、字符串、同名变量全都算作匹配,而且"谁调用了这个函数"这种问题它根本回答不了。
- **LSP** 答得准,代价是每种语言都要起一个服务端、等索引预热,而且只接受光标位置,不接受函数名。

codegraph查一次就能全部答上来。本插件把两半都带齐了:一半负责查(存储),一半负责建(索引器),所以拿到一个全新仓库也不用装别的东西。

## Agent 能用什么

两个工具,分开是有原因的。

### `codegraph` —— 十种只读查询

| 操作 | 回答什么 | 必填参数 |
|---|---|---|
| `search` | 这个符号在哪定义的? | `query` |
| `node` | 某个符号,连同调用它的和它调用的 | `symbol` |
| `callers` | 谁调用了它? | `symbol` |
| `callees` | 它调用了谁? | `symbol` |
| `impact` | 改了它会影响到哪些地方? | `symbol` |
| `trace` | 从 A 是怎么走到 B 的? | `from`、`to` |
| `files` | 某个目录或 glob 下索引了哪些文件? | — |
| `status` | 索引多大、什么时候建的? | — |
| `explore` | 一组相关的定义,连源码一起给 | `query` |
| `context` | 跟某个任务有关的所有东西 | `task` |

工具还会把自己的状态写进系统提示词。每一次装配提示词都带一行当前工作区的索引状态——多少文件、多少声明、多少关系、建于何时、跳过了多少生成产物；没有索引时则直接说必须先跑 `codegraph_index`。这一行的 `text` 是函数，由宿主每次请求重新求值，所以模型不用先调一次 `status` 才知道这些。

**重复建索引只解析变过的文件。** 每次成功的索引都会把每个文件的抽取结果留在 `.codegraph/cache/` 下;下一次索引——再跑一次 `codegraph_index`,或者 watch 在改了一行之后触发的重建——按记录的 mtime 和大小确认内容没变,直接复用上次的抽取结果,不再读盘、不再 parse。本机实测一个 337 文件的工作区,重复索引 45ms,首次 991ms。边和调用解析仍然每次整图重算,这是故意的:按"全仓库唯一名"解析调用的规则本身就是全局的,一个文件里新增的符号可以让另一个从没改过的文件里的边失效。`cacheVerify: 'hash'` 用一次读盘换正确性,应对"checkout 回退旧文件但 mtime 没动"的情形。

**大工作区转后台建索引。** `codegraph_index` 按上一次索引的摘要估算工作量:文件数达到 `backgroundIndexThreshold` 就把这一轮交给宿主的 job registry,立刻返回 job id,而不是把一个工具调用挂上几分钟。`job_output <id>` 读报告,`job_kill <id>` 停掉。小工作区仍走同步路径,常见场景不多付一次 job 往返。`backgroundIndex: true` / `false` 可以强制覆盖这个估算。

**新会话开局就有索引。** agent 创建时若它所在的工作区还没有索引,插件会通过宿主的 job registry 直接在后台建一个,所以第一个结构性问题就有图可用,不用先花三轮走 `status` → `codegraph_index` → 重试。已经有索引的工作区不动(交给 watcher 维护);宿主没有 job registry 就跳过自动建,而不是阻塞会话创建。

**中文任务描述也能拿到英文候选。** `context` 按标识符词重叠排序,而中文任务里一个标识符都没有——在 adx-admin-backend 上实测,「修改报表页的分页与筛选参数」返回空。现在内置一张高频中文开发词表,把词映射成标识符候选(报表→`report`、分页→`page`/`pageSize`/`pagination`、筛选→`filter`/`search`…),追加在原文词之后;同一句任务现在会先搜 `report`、`page`、`filter`、`param`。`contextSynonyms` 可以按部署扩展这张表。

**线上有新版本时,用完工具就说一声。** 插件没法自我升级——它装在 profile 的依赖树里,改那棵树是宿主的事。所以它做次优的那件事:某个工具被调用之后,后台查一次 registry,发现线上版本比正在运行的更新,就把一条通知追加进下一步的对话,模型和用户都看得见。三个细节让它不至于变成噪音:检查只在工具用过之后才发生,一次会话里不会凭空提醒;同一条版本只提醒一次,`notifiedVersion` 落盘记着,重启桌面也不会重播;查询间隔默认六小时,查不到、超时、写盘失败都只是"没有可说的",绝不影响工具本身。registry 按 npm 自己的顺序解析——`npm_config_registry` 环境变量优先,其次用户 `~/.npmrc` 里的 `registry=`,最后才是 npm 官方地址——所以配了镜像的机器查的就是镜像。`updateCheck: false` 关掉整个检查,`updateCheckIntervalMs` 调间隔。

### `codegraph_index` —— 建索引或重建

它没有做成第十一个操作,而是单独一个工具,原因很实际:建索引可能要几分钟,查询是毫秒级,而一个工具的超时预算在注册时就写死了。合在一起就只能二选一——预算给小了,大仓库建到一半被掐;给大了,查询卡死也发现不了。

建索引永远要显式调用。任何查询都不会顺手帮你建,因为一次 `callers` 悄悄跑了四分钟,在模型看来跟工具挂掉没有区别。

没有索引的时候,`status` 不会报错,而是直接告诉模型"这里没索引,去调 `codegraph_index`"。其他操作则会明确失败——这样"还没建索引"和"建了但是空的"不会被混为一谈。

## 和 `codegraph` CLI 的关系

数据格式不是我们发明的。本插件读写的是 `<projectRoot>/.codegraph/codegraph.db`,schema 版本 4,跟 [`@colbymchenry/codegraph`](https://github.com/colbymchenry/codegraph) 完全一致。

于是:

- **已经在用 `codegraph` CLI 的**,索引直接拿来就能查,`codegraph_index` 这一步可以跳过。
- **用本插件建的索引**,CLI 那边照样读得懂。
- 同一个仓库不会出现两份对不上的图。

## 为什么不干脆去 spawn 那个 CLI

完全可以做另一种插件:把 `@colbymchenry/codegraph` 自己的 CLI 包一层——`spawn` 成子进程,把它的每个命令包成一个工具,一下午就能做完。这个仓库没走这条路,理由很具体:

- **没有第二个要装的东西。** Shell 出去调 CLI,意味着宿主机得装那个二进制、还得是插件真正测过的那个版本——多一步安装,也多一个两边版本漂移不同步的风险点。这里 `npm install` 就是全部——索引器和存储都在进程内跑,不 spawn 任何东西。
- **工具越少越好,不是越多越好。** 每个工具的 schema 不管这一轮用不用都会跟着塞进 system prompt。十个各管一件事的工具(CLI 每个子命令包一个)每一轮都比这里的两个更吃这份预算——`codegraph` 的 `operation` 字段是分发,不是妥协。
- **增量的是解析缓存,不是边。**"只同步改动的文件"听起来显然更快,但这张图靠"全仓库唯一同名者胜出"这条规则解析调用关系,而这条规则是**全局**的:A 文件新增一个和 B 文件里已索引符号重名的定义,应该让原本指向 B 的边失效,哪怕 B 自己一行没改。只重新解析改动文件、**再把它自己的新边贴进去**的解析器,没法察觉到这一层。所以这里把两件事拆开:每个文件的抽取结果缓存复用(**337 个文件 991ms → 45ms**),而边每次都整图重算。该省的不是"重新解析",是重复解析;重新解析全部并重建边其实很便宜。

## 支持哪些语言

十八种,全部内置,不需要按语言单独配置。语法按需加载,所以纯 Go 项目不会白白加载 Python 那一套。

| 语言 | 扩展名 | 语言 | 扩展名 |
|---|---|---|---|
| TypeScript | `.ts` `.mts` `.cts` | C | `.c` `.h` |
| TSX | `.tsx` | C++ | `.cpp` `.cc` `.cxx` `.hpp` `.hh` `.hxx` |
| JavaScript | `.js` `.mjs` `.cjs` | C# | `.cs` |
| JSX | `.jsx` | PHP | `.php` |
| Python | `.py` `.pyi` | Rust | `.rs` |
| Go | `.go` | Ruby | `.rb` |
| Java | `.java` | Zig | `.zig` |
| Kotlin | `.kt` `.kts` | Swift | `.swift` |
| Dart | `.dart` | Scala | `.scala` `.sc` |

**但存储端不挑语言,只认格式。** 用 `codegraph` CLI 在其他语言上建出来的图,本插件照样查得动。表里没有的语言,用 CLI 建索引、用插件查,是可行的组合。

## 自动索引

三件事让图自己保持最新,不用你操心:

- **新会话开局就有当前索引。** 在一个从没建过索引的工作区开会话——或者索引已经超过十分钟——插件会在后台给它建一个。这次刷新同时是宿主重启后 watcher 的起点:监听只在一次成功的索引建立基线之后才开始,否则重启过的宿主会一直停在上一进程留下的那张图上。
- **监听默认开着。** 每个在范围内的目录都通过宿主的文件系统 seam 监听,防抖期过后触发重建;差分为空就不排重建,所以插件自己写 `.codegraph` 不会自激。
- **重复建索引只解析变过的文件。** 每次成功的索引都会把每个文件的抽取结果落盘;下一次按 mtime+大小确认(或用 `cacheVerify: 'hash'` 比 SHA-256),命中就复用。本机实测一个 337 文件的工作区:**首次 991ms,之后每次 45ms**;改一行触发的重建,代价约等于复用其余全部文件。

另外两件事保证它不只是"新",而是"对":提交进仓库的构建产物(比如 `dist/`)按形状跳过,那些压成一两个字母的名字不会污染解析;大工作区的首次索引会转成后台 job,不会把一个工具调用挂上几分钟。

## 这个插件多了什么

相对"让 agent 去 shell 一个 CLI",这里有五件东西:

1. **没有第二个运行时。** `dsh plugin add dsh-plugin-codegraph` 就是全部安装——不用往 `PATH` 里放二进制、不用接 MCP server、不用维护插件与 CLI 的版本同步。
2. **索引自己会起来。** 在没索引的工作区开会话,后台就建好了;之后每次改动由 watcher 接住。
3. **模型知道自己查的是什么东西的状态。** 每次请求的提示词都带着索引多大、什么时候建的、跳过了多少生成产物——免费的,不用花一次 `status` 往返。
4. **给人用的入口。** `/codegraph status|index|files`,加上设置页面板里的重建按钮。两个都不占模型回合。
5. **重建索引很便宜。** 解析缓存让重复索引在 337 个文件上从 991ms 降到 45ms,所以"回答之前先重建一次"不再是个昂贵的习惯。

## 和 `codegraph` CLI 的对比

那个 CLI 是这份磁盘格式的源头,语言覆盖也比本插件的索引器广。两者面向的场合不同:

| | 本插件 | [`@colbymchenry/codegraph`](https://github.com/colbymchenry/codegraph) |
|---|---|---|
| **形态** | DSH 插件:两个工具、一个 `/codegraph` 命令、一个设置页面板、一段提示词 | MCP server + CLI,自己装、自己接进每个 agent |
| **安装** | `dsh plugin add dsh-plugin-codegraph`,没有第二个运行时、不用配 MCP | 装 CLI、跑它的 setup 把 MCP server 接进各 agent、再对每个项目 `codegraph init` |
| **首次建索引** | 自动:在没索引的工作区开会话就建 | 每个项目显式 `codegraph init` |
| **索引状态** | 每轮提示词一行(规模、时间、跳过的产物)+ 设置页面板 | 问它的 MCP 工具 |
| **重复索引成本** | 解析缓存,337 文件 991ms → 45ms | 本机未测 |
| **后台建索引** | 超过约 1000 文件转 `ctx.jobs` | 本机未测 |
| **入仓构建产物** | 按形状跳过(`.min.` 或平均行长 > 500) | 本机未测 |
| **语言** | 18 种内置语法 | 40+,含 ArkTS、Vue、Svelte、Solidity、Terraform |
| **磁盘格式** | schema v4,就是 CLI 的路径与格式 | schema v4(源头) |

本插件加的不是"更好的图"——是同一份图,送到 DSH 能直接用它的地方:没有第二个进程、没有 MCP 管道、模型每轮免费读到状态、人有命令、有界面。

## Rust 引擎

解析曾经是这个插件唯一明显慢的地方,原因在结构上:`parse` 加 `extractFile` 跑在宿主主线程、走 `web-tree-sitter`、一次一个文件。现在这一步交给原生 addon——`tree-sitter` 编进 Rust、rayon 一个核一个 worker——并且**已经对 TypeScript / TSX / JavaScript / JSX 生效**。

| | JS + WASM | Rust addon |
|---|---|---|
| parse + extract(336 文件,同输入) | 727ms | **110ms** |
| 整轮 walk(337 文件工作区,4 次中位) | 807–886ms | **277–336ms**(2.6–2.9×) |

整轮数字比引擎数字低,是因为 walk 不只做抽取:读文件、算哈希、缓存判定、最终写库都没变,而且那个工作区里有 3 个文件无论如何都得走 JS(见下)。没有这类文件的工作区,差距会更大。

三个要知道的点:

- **可选,而且会安静地降级。** addon 以 `.node` 平台产物分发;缺失、没构建、或者抛错时,每个文件都回退到 JS 抽取器。`engine: 'js'` 强制走老路,`'auto'`(默认)能用 addon 就用。
- **规则表不做第二份。** addon 收到的是 `LANGUAGE_TABLE` 的 JSON,靠它建匹配器,所以两个引擎在"规则怎么说"上不可能漂移——能差的只有"实现得多准",而这正是对拍测试在量的东西。
- **解析树有错的文件留给 JS 引擎。** 两份语法(WASM 0.20 vs crate 0.23/0.25)对畸形输入的恢复方式不同——真实工作区上表现为一条假定义和一处行号差 1——所以 addon 拒收这类文件,由 `walk` 按老办法抽取。宁可慢,不要错。

`packages/tree-sitter/tests/rust-parity.spec.ts` 断言两个引擎在每个 fixture 上产出**逐字节相同**的抽取结果;设置 `CODEGRAPH_PARITY_WORKSPACE` 时还会对真实工作区做同样的断言。

**覆盖与下一步。** 目前四种语言。Python、Go、Java、C/C++、Rust、C# 等仍然走 JS 抽取器,行为完全不变;每加一种语言都需要补 Rust 侧的特判并跑一遍对拍。多平台二进制(Linux、Windows、两种架构)还没发布——怎么构建 addon 写在 [`crates/indexer-rust/README.md`](crates/indexer-rust/README.md)。
## 宁可漏,不可错

每个调用点按固定顺序解析:先看 import 能不能指向某个已索引的文件;不行就看**调用方这个文件自己**是不是恰好只有一个同名定义——词法作用域先于全仓库说话,两个测试文件各有一个 `helper`、两个组件各有一个 `render`,都不会被当成歧义;再不行才看全仓库是不是只有一个同名定义;还不行,**就不产出这条边**,把它记进未解析计数。

同文件这一层只对裸调用生效。成员调用(`x.map()`)取的是接收者的属性,而这个解析器没有类型信息,凭一个同名本地定义连上去就是猜,不是作用域解析。

最后这条是故意的。模型是拿 `callers` 的结果去干活的——报错一个调用方,它就跑去改错文件;漏报一个,它顶多退回去用文本搜索。前者的代价高得多。但索引报告里的 `unresolved_count` 本身不等于"漏了多少"——没有类型信息,成员调用(`x.map()`)和文件自己已经 import 但没解析到工作区文件的名字,压根就不是解析器有机会settle的对象,一般项目里这两类占了未解析总数的大头。真正该拿来衡量完整度的是 `unresolved_likely_internal_count`:结构上看起来像是工作区内部调用、但没解析成的那部分。

## 命令与面板

给人用的两个入口,数据都来自同一份索引:

- **`/codegraph [status|index|files <pattern>]`** —— 报告当前工作区的索引、重建它、或列出已索引的文件;不写子命令时默认 `status`。
- **设置 → 代码图谱** —— 一个面板,显示工作区的索引状态(文件数、声明数、关系数、未解析数、建于何时、跳过了多少生成产物),带一个路径输入框和一个重建按钮。数据来自插件自己的 `/dsh-plugin-codegraph/api/state` 与 `/api/reindex`,只读 `<root>/.codegraph/status.json`,不开放任意文件访问。

## 安装

```sh
dsh plugin --profile <name> add dsh-plugin-codegraph
```

就这一条命令,装完就完事:它会拉包,还会自动 reconcile profile 的 manifest,把 `dsh-plugin-codegraph` 追加进 `dsh.profile.bundles`。不用手动改任何 JSON。跑完之后,`$DSH_HOME/profiles/<name>/package.json`(`$DSH_HOME` 默认是 `~/.dsh`)长这样——这里给出来是让你核对,不是让你去写:

```jsonc
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "dsh-plugin-codegraph"]
    }
  }
}
```

想在不花 API key 的情况下确认四个插件都挂上了,跑 `dsh --profile <name> --dump-default-config`,它们会分组显示在 `# == dsh-plugin-codegraph` 标题下面。

一个 bundle 会把四个插件一次挂全。要调其中某个,在 profile 自己的 `cordis.patch.yml` 里按 id 改就行(`codegraph`、`codegraph-sqlite`、`codegraph-tree-sitter`、`codegraph-tool`):

```yaml
- id: codegraph-tree-sitter
  config:
    languages: ['typescript', 'tsx']
    exclude: ['node_modules', 'dist', 'vendor']
    respectGitignore: true
    skipMinified: true # 这是默认值,写出来只是为了清楚——想让压缩产物也进图就设 false
    engine: auto # auto | js | rust —— auto 表示能上原生 addon 就用
    watch: true # 这是默认值,写出来只是为了清楚——想关掉设 false

- id: codegraph-tool
  config:
    maxLimit: 50
    indexTimeoutMs: 600000
```

## 包结构

装 bundle 就够了,下面这张表是给想自己拼的人看的。

| 包 | 干什么的 |
|---|---|
| [`dsh-plugin-codegraph`](packages/bundle) | bundle,依赖下面四个,提供那份补丁层 |
| [`dsh-plugin-codegraph-service`](packages/service) | 定义 `ctx.codegraph`:Provider 注册表和查询词汇 |
| [`dsh-plugin-codegraph-sqlite`](packages/sqlite) | 只读 SQLite 存储,负责查 |
| [`dsh-plugin-codegraph-tree-sitter`](packages/tree-sitter) | tree-sitter 索引器,负责建 |
| [`dsh-plugin-codegraph-tool`](packages/tool) | 模型可见的工具、边界和输出呈现 |

拆这么细不是为了好看。定义层不碰源码文本、也不做任何文件读写,所以存储根本不需要文件系统权限;要拿一个定义的源码,是在工具层把图查询和一次 `ctx.fs` 读取拼起来完成的——只有工具层够得着远程工作区的文件。

## 目前的局限

- **文件监听默认开启,走的是宿主的文件系统 seam。** 一次成功的 `codegraph_index` 之后就会自动开始监听那个 root:每个在监听范围内的目录一个 watch,通过 `ctx.fs.watch` 建立而不是直接用 `node:fs`,这样后端在另一个执行世界里提供的工作区,就在它真正所在的地方被监听。seam 的变化回调不携带文件名,所以重建靠"重新列举被监听的目录并与上一轮快照做差分"来触发;差分为空就不排重建,这正好让索引器自己写 `.codegraph` 的行为不会自激。后端不支持监听时会带着原因降级成手动建索引,而不是让插件失败。设 `watch: false` 可以关掉,回到纯手动建索引。在 WSL2 内核监听一个从 Windows 主机挂进来的路径(`/mnt/<盘符>/...`)时会被自动改回关闭,因为 inotify 在这种挂载上投递事件不可靠,`CODEGRAPH_FORCE_WATCH=1` 和 `CODEGRAPH_NO_WATCH=1` 可以双向覆盖这个默认值。不管监听开没开,`status` 都会直接 stat 磁盘,报出有多少已索引文件自上次建索引以来改过或被删了,调用方始终能分清"这份索引还准"和"这份索引已经飘了",不用瞎猜。
- **Git hooks 和 worktree 探测只以库函数形式提供**——`installGitHooks`/`uninstallGitHooks`(装一个 `post-checkout`/`post-merge`/`post-commit`/`post-rewrite` 钩子去跑你指定的命令,适合用不了实时监听的环境)和 `detectWorktree`(判断某个 root 是不是一个 `git worktree`,以及它的主仓库在哪)。两者都没有接进插件加载流程,也没有暴露成模型可见工具:`.git/hooks/*` 是共享的、这个包并不拥有的环境状态,装不装由调用方在自己的初始化脚本里决定,绝不自动执行。
- **提交进仓库的构建产物,按形状跳过,不靠 `.gitignore`。** 有些部署把 `dist/` 一起提交,好让服务器直接从仓库里取——这种目录既没被 gitignore,也不在内置默认目录里。可它们终究是打包器的输出:本机实测一个仓库里 25 个这样的文件占了一份 335 个源文件的图里 90% 的定义、86% 的边、92% 的未解析调用点;它们那些被压成一两个字母的名字还会和真实符号撞车,让"全仓库唯一名"规则放弃本来能连上的调用。`skipMinified`(默认开)会跳过两类文件:路径里带 `.min.` 段的,或者平均行长超过 500 字符的——大约是手写源码实测最大平均行长(约 70)的 7 倍——跳过的数量在报告里体现为 `files_minified`。这是启发式,不是接构建系统:要精确,还是把产物目录写进 `exclude`;想让它们进图,设 `skipMinified: false`。
- **排除规则是内置默认目录和项目自己的 `.gitignore` 取并集。** 编译产物落在 `node_modules`/`dist`/`build`/`coverage` 之外的目录(比如某些 TypeScript 项目编译到 `lib`)几乎总是被 gitignore 的,不排除的话,同一个符号会在源码和编译产物里各存在一份,调用解析只能在两者间随便选一个。这里只实现了 gitignore 语法的一个够用子集,不支持 `**`、字符类,也不认per-目录的 `.gitignore` 文件。想关掉就设 `respectGitignore: false`。
- **未解析尾巴可能很大,但大部分不是漏边。** `unresolved_count` 把成员调用和已 import 的名字都算进去了,这些本来就不是无类型解析器能 settle 的对象;真正反映再导出、动态派发漏了多少的,是口径更窄的 `unresolved_likely_internal_count`。
- **`context` 是按词匹配的**,把任务描述拆成标识符再找。中文任务会先经过内置词表映射成英文候选,但词表只覆盖常见开发词、不覆盖任意散文;一句没提到任何符号名、主题词又不在表里的任务,匹配质量依然很差,这里没有语义检索。
- `dsh` 本身还在 developer preview,迭代快,会有破坏性变更。

## 致谢

数据格式——`.codegraph/codegraph.db` 里的 schema 版本 4——出自 [`@colbymchenry/codegraph`](https://github.com/colbymchenry/codegraph)(MIT),一个面向 AI agent 的本地代码检索工具。本插件特意沿用这个格式,好让两边的索引能互相读取。索引器、存储和工具本身是照着 DeepSeek Harness 的插件模型另行实现的。

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 和 [Cordis](https://github.com/cordiverse/cordis)。

## 反馈

有问题或者需要支持,欢迎在 [Issues](https://github.com/CC19990113/dsh-plugin-codegraph/issues) 提出。

## 许可

[MIT](LICENSE)
