# dsh-plugin-codegraph-tool

The model-facing tools: a read-only `codegraph` tool with ten structural query operations, plus a `codegraph_index` tool that builds or refreshes the index on its own, much larger timeout budget.

Part of **[dsh-plugin-codegraph](https://github.com/CC19990113/dsh-plugin-codegraph)** — structural code intelligence for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Most users should install the bundle instead, which mounts this package and its siblings in one layer:

```sh
dsh plugin --profile <name> add dsh-plugin-codegraph
```

See the [project README](https://github.com/CC19990113/dsh-plugin-codegraph#readme) for setup, configuration, and the full tool reference.

## License

[MIT](LICENSE)
