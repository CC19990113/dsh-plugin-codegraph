# dsh-plugin-codegraph

[English](README.md) | 中文

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(`dsh`)提供结构化代码智能。

给 agent 两个工具 —— `codegraph` 和 `codegraph_index` —— 让它能问**这个符号声明在哪**、**谁在调用它**、**改动它会波及什么**、**一个符号如何抵达另一个**,答案来自预建索引而不是文本搜索。

```sh
dsh plugin --profile <name> add dsh-plugin-codegraph
```

## 为什么需要它

Agent 动手改代码前会先问结构性问题,而它平时手上的工具要么答得很差,要么根本答不了:

- **grep** 会命中注释里、字符串里和无关标识符里的同名文本,而且完全答不了"谁在调用它"。
- **LSP** 答得精确,但需要每种语言各跑一个服务端、需要预热好的工作区索引,而且要的是**光标位置**而不是名字。

符号图一次廉价查询就能答完这些。本插件两半都带:一个从磁盘图作答的**存储**,和一个把图建出来的**索引器**,所以全新工作区不需要任何外部工具。

## 模型拿到什么

两个工具,刻意分开。

### `codegraph` —— 十个只读操作

| 操作 | 回答 | 必填 |
|---|---|---|
| `search` | 某个符号声明在哪? | `query` |
| `node` | 一个符号连同其直接调用方与被调用方 | `symbol` |
| `callers` | 什么在调用它? | `symbol` |
| `callees` | 它调用了什么? | `symbol` |
| `impact` | 改动它会波及什么? | `symbol` |
| `trace` | 一个符号如何抵达另一个? | `from`、`to` |
| `files` | 某个目录或 glob 下索引了哪些文件? | — |
| `status` | 索引多大、多新? | — |
| `explore` | 若干相关声明连同其源码 | `query` |
| `context` | 与某个任务相关的一切 | `task` |

### `codegraph_index` —— 构建或刷新图

它是独立工具而不是第十一个操作,因为为大工作区建索引要花几分钟,而一次查询是毫秒级,同时一个工具的超时预算在注册时就定死了。把两者合并会逼出一个"要么对真实构建太紧、要么松到抓不住卡死查询"的共用预算。

建索引永远是显式的。任何查询都不会隐式触发它:一次悄悄花掉四分钟的 `callers` 调用,在模型看来与工具卡死无从区分。

当索引不存在时,`status` 会**如实作答而不是失败** —— 它会说没有索引,并点名 `codegraph_index` 是解法。其余每个操作则会响亮失败,这样"未索引的工作区"永远不会被误读成"空工作区"。

## 与 `codegraph` CLI 的互通

磁盘格式**不是我们的**。本插件读写的是 **`<projectRoot>/.codegraph/codegraph.db` 下的 schema 版本 4** —— 正是 [`@colbymchenry/codegraph`](https://github.com/colbymchenry/codegraph) 写入的同一路径与同一格式。

这意味着:

- **已经在用 `codegraph` CLI?** 它的索引会被直接接管。挂上插件,完全跳过 `codegraph_index`,直接查。
- **用本插件建的索引?** CLI 照样读得懂。
- 一个工作区永远不会出现两份互相矛盾的图。

## 语言覆盖

内置索引器解析 **TypeScript、TSX、JavaScript、JSX、Python 和 Go**。语法按语言懒加载 —— 在首次见到匹配文件时加载 —— 所以纯 Go 的工作区永远不会加载 Python 语法。

**存储受格式约束,不受语言约束**:由 `codegraph` CLI 在本索引器不解析的语言上建出来的图,依然可以完整查询。如果你现在就需要更广的索引覆盖,用 CLI 建索引、用本插件查询。

## 调用解析绝不猜

每个调用点按固定顺序解析:落在已索引文件上的 import 胜出;否则全工作区唯一同名者胜出;否则**不产出任何边**,该调用点记为未解析。

最后这条是刻意的。模型会依据 `callers` 的输出行动,一个自信但错误的调用方会把它送去改错文件,而一个缺失的调用方只是把它送回文本搜索。索引报告里的 `unresolved_count` 让这个缺口的大小可见,而不是把它藏起来。

## 安装

```sh
# 1. 把插件装进某个 profile
dsh plugin --profile <name> add dsh-plugin-codegraph
```

```jsonc
// 2. 在 $DSH_HOME/profiles/<name>/package.json 里列出它
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "dsh-plugin-codegraph"]
    }
  }
}
```

bundle 会用一个层挂载全部四个插件。想调整其中任何一个,在该 profile 自己的 `cordis.patch.yml` 里按 bundle 声明的 id 寻址(`codegraph`、`codegraph-sqlite`、`codegraph-tree-sitter`、`codegraph-tool`):

```yaml
- id: codegraph-tree-sitter
  config:
    languages: ['typescript', 'tsx']
    exclude: ['node_modules', 'dist', 'vendor']

- id: codegraph-tool
  config:
    maxLimit: 50
    indexTimeoutMs: 600000
```

## 包组成

装 bundle 就够了;下面列出来是给想手工组合的人看的。

| 包 | 角色 |
|---|---|
| [`dsh-plugin-codegraph`](packages/bundle) | bundle —— 依赖下面四个并提供补丁层 |
| [`dsh-plugin-codegraph-service`](packages/service) | Service Definition:`ctx.codegraph`、Provider 注册表、查询词汇表 |
| [`dsh-plugin-codegraph-sqlite`](packages/sqlite) | Service Provider:架在磁盘图之上的只读 SQLite 存储 |
| [`dsh-plugin-codegraph-tree-sitter`](packages/tree-sitter) | Service Provider:写出那份图的 tree-sitter 索引器 |
| [`dsh-plugin-codegraph-tool`](packages/tool) | Consumer:模型可见的工具、其边界与呈现 |

这个拆分不是形式主义。本 seam 不承载源文本、也不做任何文件系统访问,因此存储完全不需要文件系统能力;取一个声明的源码是在 Consumer 里把图查询与一次 `ctx.fs` 读取组合起来,而 Consumer 是唯一能触达远程工作区文件的角色。

## 已知限制

- **新鲜度没人负责。** 它只建索引,不监视变更。一次 `codegraph_index` 之后被编辑的文件,会保留旧声明直到下一次运行。
- **未解析的尾巴可能很大**,在大量依赖再导出或动态分发的代码库里尤其如此。`unresolved_count` 度量它。
- **`context` 按标识符词项重合度排序**,所以完全没点到任何符号名的任务描述排序质量差。不存在语义匹配。
- `dsh` 自身处于 developer preview 且迭代很快,预期会有破坏性变更。

## 致谢

磁盘图格式 —— `.codegraph/codegraph.db` 下的 schema 版本 4 —— 源自 [`@colbymchenry/codegraph`](https://github.com/colbymchenry/codegraph)(MIT),一个面向 AI agent 的本地优先代码智能工具。本插件刻意采用该格式,以保持两者互相可读;这里的索引器、存储与工具是针对 DeepSeek Harness 插件模型编写的独立实现。

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 与 [Cordis](https://github.com/cordiverse/cordis) 构建。

## 许可

[MIT](LICENSE)
