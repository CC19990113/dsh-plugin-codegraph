/**
 * Package-owned invariant companion for `dsh-plugin-codegraph-service`.
 * @module dsh-plugin-codegraph-service/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-plugin-codegraph-service'

/** Cordis companion plugin name. */
export const name = 'codegraph-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: store reservations are private state resolved per query, and the seam emits
 * no lifecycle event and exposes no enumerable snapshot to compare an owned relation against.
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
