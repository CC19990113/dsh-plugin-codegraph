/**
 * Package-owned invariant companion for `dsh-plugin-codegraph-tool`.
 * @module dsh-plugin-codegraph-tool/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-plugin-codegraph-tool'

/** Cordis companion plugin name. */
export const name = 'tool-codegraph-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this stateless adapter contributes one tool and prompt section, while graph
 * query results and source retrieval remain owned by the codegraph and filesystem seams it composes.
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
