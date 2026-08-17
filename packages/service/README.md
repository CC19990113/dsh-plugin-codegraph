# dsh-plugin-codegraph-service

Service Definition for the code-graph capability seam: publishes `ctx.codegraph`, the store and indexer provider registries, and the eight normalized structural queries. Carries no store, no indexer, and no filesystem access of its own.

Part of **[dsh-plugin-codegraph](https://github.com/CC19990113/dsh-plugin-codegraph)** — structural code intelligence for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Most users should install the bundle instead, which mounts this package and its siblings in one layer:

```sh
dsh plugin --profile <name> add dsh-plugin-codegraph
```

See the [project README](https://github.com/CC19990113/dsh-plugin-codegraph#readme) for setup, configuration, and the full tool reference.

## License

[MIT](LICENSE)
