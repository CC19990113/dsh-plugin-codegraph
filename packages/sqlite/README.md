# dsh-plugin-codegraph-sqlite

Read-only SQLite store for the code-graph seam. Serves structural queries from the schema-v4 graph at `.codegraph/codegraph.db` — the same on-disk format the `codegraph` CLI writes — opening it read-only and gating on its recorded format version.

Part of **[dsh-plugin-codegraph](https://github.com/CC19990113/dsh-plugin-codegraph)** — structural code intelligence for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Most users should install the bundle instead, which mounts this package and its siblings in one layer:

```sh
dsh plugin --profile <name> add dsh-plugin-codegraph
```

See the [project README](https://github.com/CC19990113/dsh-plugin-codegraph#readme) for setup, configuration, and the full tool reference.

## License

[MIT](LICENSE)
