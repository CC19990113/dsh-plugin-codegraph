# dsh-plugin-codegraph

[English](README.md) | 中文

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(`dsh`)加上结构化代码检索能力。

装上之后,agent 多出两个工具:`codegraph` 和 `codegraph_index`。它能直接问"这个函数在哪定义的""谁调用了它""改了它会影响哪些地方""从 A 怎么走到 B",答案来自预先建好的符号索引,不是靠 grep 猜。

```sh
dsh plugin --profile <name> add dsh-plugin-codegraph
```

## 解决什么问题

Agent 改代码之前,总要先搞清楚代码之间的关系。但它手上的工具在这件事上都不好使:

- **grep** 会把注释、字符串、同名变量全都算作匹配,而且"谁调用了这个函数"这种问题它根本回答不了。
- **LSP** 答得准,代价是每种语言都要起一个服务端、等索引预热,而且只接受光标位置,不接受函数名。

符号图查一次就能全部答上来。本插件把两半都带齐了:一半负责查(存储),一半负责建(索引器),所以拿到一个全新仓库也不用装别的东西。

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

### `codegraph_index` —— 建索引或重建

它没有做成第十一个操作,而是单独一个工具,原因很实际:建索引可能要几分钟,查询是毫秒级,而一个工具的超时预算在注册时就写死了。合在一起就只能二选一——预算给小了,大仓库建到一半被掐;给大了,查询卡死也发现不了。

建索引永远要显式调用。任何查询都不会顺手帮你建,因为一次 `callers` 悄悄跑了四分钟,在模型看来跟工具挂掉没有区别。

没有索引的时候,`status` 不会报错,而是直接告诉模型"这里没索引,去调 `codegraph_index`"。其他操作则会明确失败——这样"还没建索引"和"建了但是空的"不会被混为一谈。

## 和 `codegraph` CLI 的关系

磁盘格式不是我们发明的。本插件读写的是 `<projectRoot>/.codegraph/codegraph.db`,schema 版本 4,跟 [`@colbymchenry/codegraph`](https://github.com/colbymchenry/codegraph) 完全一致。

于是:

- **已经在用 `codegraph` CLI 的**,索引直接拿来就能查,`codegraph_index` 这一步可以跳过。
- **用本插件建的索引**,CLI 那边照样读得懂。
- 同一个仓库不会出现两份对不上的图。

## 支持哪些语言

自带的索引器能解析 **TypeScript、TSX、JavaScript、JSX、Python、Go** 六种。语法是按需加载的,只在第一次遇到对应文件时才载入,所以纯 Go 项目不会白白加载 Python 语法。

**但存储端不挑语言,只认格式。** 用 `codegraph` CLI 在其他语言上建出来的图,本插件照样查得动。所以如果你现在就需要更广的语言覆盖,用 CLI 建索引、用插件查,是可行的组合。

## 宁可漏,不可错

每个调用点按固定顺序解析:先看 import 能不能指向某个已索引的文件;不行就看全仓库是不是只有一个同名定义;还不行,**就不产出这条边**,把它记进未解析计数。

最后这条是故意的。模型是拿 `callers` 的结果去干活的——报错一个调用方,它就跑去改错文件;漏报一个,它顶多退回去用文本搜索。前者的代价高得多。索引报告里的 `unresolved_count` 会把漏了多少摆在明面上,不藏着。

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

- **索引会不会过时现在看得见了,但还是不会自动更新。** 它本身不监视文件变化,不过 `status` 会直接 stat 磁盘,报出有多少已索引文件自上次建索引以来改过或被删了。调用方能分清"这份索引还准"和"这份索引已经飘了",不用瞎猜。要刷新就跑 `codegraph_index`。
- **排除规则是内置默认目录和项目自己的 `.gitignore` 取并集。** 编译产物落在 `node_modules`/`dist`/`build`/`coverage` 之外的目录(比如某些 TypeScript 项目编译到 `lib`)几乎总是被 gitignore 的,不排除的话,同一个符号会在源码和编译产物里各存在一份,调用解析只能在两者间随便选一个。这里只实现了 gitignore 语法的一个够用子集,不支持 `**`、字符类,也不认per-目录的 `.gitignore` 文件。想关掉就设 `respectGitignore: false`。
- **漏掉的调用边可能不少**,尤其是大量用再导出、动态派发的代码库。具体漏了多少看 `unresolved_count`。
- **`context` 是按词匹配的**,把任务描述拆成标识符再找。所以一句没提到任何符号名的任务,匹配质量会很差,这里没有语义检索。
- `dsh` 本身还在 developer preview,迭代快,会有破坏性变更。

## 致谢

磁盘格式——`.codegraph/codegraph.db` 里的 schema 版本 4——出自 [`@colbymchenry/codegraph`](https://github.com/colbymchenry/codegraph)(MIT),一个面向 AI agent 的本地代码检索工具。本插件特意沿用这个格式,好让两边的索引能互相读取。索引器、存储和工具本身是照着 DeepSeek Harness 的插件模型另行实现的。

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 和 [Cordis](https://github.com/cordiverse/cordis)。

## 许可

[MIT](LICENSE)
