/**
 * Exhaustiveness guard for a closed union, owned by this package rather than borrowed from the host.
 *
 * The equivalent helper used to live in `@deepseek-ai/dsh-llm`; the 0.2.1 runtime moved it to
 * `@deepseek-ai/dsh-util-values` and stopped re-exporting it from the old location, which turns a
 * static `import { assertNever } from '@deepseek-ai/dsh-llm'` into a load-time failure — the whole
 * consumer plugin vanishes from the host instead of failing at one unreachable branch. Carrying the
 * three lines here keeps every codegraph package loadable across host versions instead of pinning one.
 * @module dsh-plugin-codegraph-service/assert
 */

/**
 * Assert at compile time that `value` is unreachable, and throw if it ever is reached at runtime.
 * @param value - the value typed `never` by an exhaustive switch or if-chain.
 * @param context - optional name of the union being switched on, for the error message.
 * @returns never — the call always throws.
 */
export function assertNever(value: never, context?: string): never {
  const rendered = JSON.stringify(value) ?? String(value)
  throw new Error(`unreachable variant${context === undefined ? '' : ` in ${context}`}: ${rendered}`)
}
