# dsh-plugin-codegraph-tree-sitter

Self-built code-graph indexer. Parses TypeScript, TSX, JavaScript, JSX, Python, Go, Java, C, and C++ with `web-tree-sitter` and writes schema version 4 to `.codegraph/codegraph.db`, so a workspace needs no external indexer. Registers only an indexer, never a store.

Part of **[dsh-plugin-codegraph](https://github.com/CC19990113/dsh-plugin-codegraph)** — structural code intelligence for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Most users should install the bundle instead, which mounts this package and its siblings in one layer:

```sh
dsh plugin --profile <name> add dsh-plugin-codegraph
```

See the [project README](https://github.com/CC19990113/dsh-plugin-codegraph#readme) for setup, configuration, and the full tool reference.

## License

[MIT](LICENSE)
