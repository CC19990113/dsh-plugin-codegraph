/**
 * Package-owned invariant companion for `dsh-plugin-codegraph-tree-sitter`.
 * @module dsh-plugin-codegraph-tree-sitter/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-plugin-codegraph-tree-sitter'

/** Cordis companion plugin name. */
export const name = 'codegraph-tree-sitter-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: an indexing run is a one-shot, caller-awaited operation with no owned
 * mutable harness state and no emitted event, so there is no owned relation between two
 * harness-visible values to compare.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
