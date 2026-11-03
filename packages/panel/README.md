# dsh-plugin-codegraph-panel

Browser half of **[dsh-plugin-codegraph](https://github.com/CC19990113/dsh-plugin-codegraph)** — the **Settings › 代码图谱** tab.

它只在 DSH 客户端里跑，零构建、零 npm 依赖（`react` 由宿主注入）：`lib/client.js` 通过
`window.__ModuleLoader__.load({ id, factory })` 注册一个 `settings.section` 槽位（id `codegraph`、
order 30、label `代码图谱`），组件里只有一个工作区路径输入框和「刷新」「重建索引」两个按钮。

所有数字都来自宿主半侧的 HTTP 路由，本包自己不开服务、不读磁盘：

| 请求 | 作用 |
| --- | --- |
| `GET /dsh-plugin-codegraph/api/state?root=<abs path>` | 读 `<root>/.codegraph/status.json`，返回 `{ ok, status }` 或 `{ ok:false, message }` |
| `POST /dsh-plugin-codegraph/api/reindex`，body `{ "root": "<abs path>" }` | 重建该工作区的图，返回 `{ ok, message }` |

工作区路径记在 `localStorage['codegraph.panel.root']`，刷新页面还在；请求失败只在面板里显示一行
错误文本，不抛异常、不白屏。

安装方式与配置见[项目 README](https://github.com/CC19990113/dsh-plugin-codegraph#readme)。

## License

[MIT](LICENSE)
