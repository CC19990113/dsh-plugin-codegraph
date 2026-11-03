/**
 * Host-side HTTP routes behind the Settings "代码图谱" panel.
 *
 * Why the tool package owns them: the panel shows the very state this package already reads for its
 * prompt section (the `status.json` sidecar, via `readIndexStatus`) and triggers the very indexer the
 * model-facing tool calls (`ctx.codegraph.index`). A separate host package would have to duplicate
 * that knowledge; here the routes add only a browser-facing entry point, never a second source of
 * truth.
 *
 * The table is deliberately tiny and fixed. `root` is the only browser-supplied input, and it may
 * name any absolute directory — the panel exists to inspect workspaces the current session is not
 * in. Every path-derived read is therefore one constant relative path joined under a validated root;
 * no caller-supplied filename ever reaches `join`, which is what keeps "show me this workspace's
 * status" from becoming an arbitrary-file-read primitive.
 *
 * Both routes are registered through conditional injection (`ctx.inject(['webServer'], …)`): a host
 * profile without the web server is a normal deployment, not an error, and losing the panel must not
 * hide the model-facing tools that share this plugin's `apply`.
 * @module dsh-plugin-codegraph-tool/panel
 */

import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { INDEX_STATUS_RELATIVE_PATH } from 'dsh-plugin-codegraph-service'
import type { IndexStatusFile } from 'dsh-plugin-codegraph-service'
import { readIndexStatus } from './status-hint.ts'

/** Path prefix every panel route lives under. The browser client hardcodes the same string. */
export const PANEL_ROUTE_PREFIX = '/dsh-plugin-codegraph/api'

/**
 * Path of the graph itself, relative to a project root.
 *
 * Mirrors the private constant in `status-hint.ts`, which is not exported. It is used here only to
 * tell "never indexed" apart from "indexed by a run that predates the summary sidecar" — the same
 * distinction the prompt line makes, because collapsing the middle case into "no index" would invite
 * a rebuild of a graph that is already there.
 */
const GRAPH_RELATIVE_PATH = '.codegraph/codegraph.db'

/**
 * Largest request body accepted by `reindex`, in bytes.
 *
 * The only body this API accepts is one JSON object with a single path string, so 64 KiB is already
 * two orders of magnitude past the contract. The cap exists so a browser (or anything else reaching
 * the port) cannot make the host buffer an unbounded request.
 */
const MAX_BODY_BYTES = 64 * 1024

/** The panel's slice of the plugin configuration. */
export interface PanelConfig {
  /** Register the routes (default true at the plugin's own schema layer). */
  readonly panel?: boolean
}

/**
 * The request face of a route handler, declared structurally.
 *
 * `@deepseek-ai/dsh-host-webserver` is not a dependency of this package: the service may be absent,
 * and importing its types would tie the install to a host package this plugin is written to live
 * without. In practice the handler receives node's `IncomingMessage`; only these members are read.
 */
export interface PanelRequest {
  /** Origin-form request target, query included (node always supplies it for http). */
  readonly url?: string
  /** HTTP method; node always supplies it. */
  readonly method?: string
  /** Body chunks, used only by `reindex`. */
  [Symbol.asyncIterator](): AsyncIterator<Buffer | string>
}

/**
 * The response face of a route handler, declared structurally for the same reason as
 * {@link PanelRequest}. In practice this is node's `ServerResponse`.
 */
export interface PanelResponse {
  /** HTTP status the handler sets before writing the body. */
  statusCode: number
  /**
   * Set one response header.
   * @param name - header name.
   * @param value - header value.
   */
  setHeader(name: string, value: string): void
  /**
   * End the response.
   * @param body - complete response body.
   */
  end(body?: string): void
}

/** One route registration, as the web server's route table takes it. */
export interface PanelRoute {
  /** Prefix matching: every path under {@link PANEL_ROUTE_PREFIX} reaches {@link handler}. */
  readonly kind: 'prefix'
  /** The claimed path prefix. */
  readonly path: string
  /**
   * Own the full request/response lifecycle.
   * @param req - the incoming request.
   * @param res - the response to write.
   */
  readonly handler: (req: PanelRequest, res: PanelResponse) => void | Promise<void>
}

/** The web server's registration surface, declared structurally. */
export interface PanelWebServer {
  /**
   * Claim one named route.
   * @param route - kind, path, and handler.
   * @returns the disposer removing the registration.
   */
  register(route: PanelRoute): () => void
}

/** A `GET /state` answer: the workspace's last indexing summary, verbatim. */
export interface PanelStateResponse {
  /** This answer carries data. */
  readonly ok: true
  /**
   * The persisted summary, returned as-is so the client renders what the indexer wrote. The sidecar
   * carries no language breakdown, so the client omits that row rather than showing an empty label;
   * deriving one is more work than this route — a fixed relative-path file read — is meant to do.
   */
  readonly status: IndexStatusFile
}

/** A `POST /reindex` answer: one indexing run finished. */
export interface PanelReindexResponse {
  /** The rebuild finished. */
  readonly ok: true
  /** One line naming what the run wrote. */
  readonly message: string
}

/** The answer every failed route call carries, whatever its HTTP status. */
export interface PanelErrorResponse {
  /** No data accompanies this answer. */
  readonly ok: false
  /** One line the panel shows verbatim. */
  readonly message: string
}

/** Any JSON body these routes can write. */
type PanelBody = PanelStateResponse | PanelReindexResponse | PanelErrorResponse

/** One route's decision: an HTTP status plus the JSON body describing it. */
interface RouteResult {
  /** HTTP status to send. */
  readonly code: number
  /** JSON body to send. */
  readonly body: PanelBody
}

/** What reading a request body produced. */
type BodyResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string }

/** Workspaces with an indexing run in flight, so a second click cannot start a parallel rebuild. */
const activeReindexes = new Set<string>()

/**
 * Register the panel's HTTP routes when the host composition provides a web server.
 *
 * Returns nothing on purpose: the registration is a lifecycle effect that the plugin's fiber disposes,
 * and a profile without the service simply never runs the callback. The try/catch is defence for an
 * exotic context whose `inject` rejects synchronously; the panel is optional, so it must never fail
 * plugin startup.
 * @param ctx - the plugin context (must carry `codegraph`; `webServer` is optional).
 * @param config - the resolved plugin configuration.
 */
export function registerPanelRoutes(ctx: Context, config: PanelConfig): void {
  if (config.panel === false) return
  try {
    ctx.inject(['webServer'], child => {
      const webServer = (child as Context & { webServer: PanelWebServer }).webServer
      child.effect(
        () => webServer.register({
          kind: 'prefix',
          path: PANEL_ROUTE_PREFIX,
          handler: (req, res) => handleRequest(ctx, req, res),
        }),
        'codegraph: settings panel api',
      )
    })
  } catch (error) {
    console.warn('[codegraph] webServer service unavailable; the settings panel cannot load its data:', error)
  }
}

/**
 * Answer one request routed under the panel prefix.
 *
 * A thrown handler becomes a 400 from the web server itself with no body the client can render, so
 * every failure this module can foresee is turned into its own JSON answer here; the catch-all only
 * covers a malformed request target or a defect, and exists so the client still gets the `ok:false`
 * shape it knows how to display.
 * @param ctx - the plugin context carrying `codegraph`.
 * @param req - the incoming request.
 * @param res - the response to write.
 * @returns settles once the response is written.
 */
async function handleRequest(ctx: Context, req: PanelRequest, res: PanelResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    // Trailing slashes are tolerated so `/state/` and `/state` are the same route; the client never
    // sends one, but a hand-typed probe might.
    const route = url.pathname.slice(PANEL_ROUTE_PREFIX.length).replace(/\/+$/u, '')
    const method = (req.method ?? 'GET').toUpperCase()
    if (route === '/state' && method === 'GET') {
      const root = workspaceRoot(url.searchParams.get('root'))
      respond(res, root === undefined ? invalidRoot() : stateResult(root))
      return
    }
    if (route === '/reindex' && method === 'POST') {
      respond(res, await reindexResult(ctx, req))
      return
    }
    respond(res, { code: 404, body: { ok: false, message: '未知的面板接口' } })
  } catch (error) {
    respond(res, { code: 500, body: { ok: false, message: String(error) } })
  }
}

/**
 * Read the workspace's persisted indexing summary.
 * @param root - an already validated absolute workspace root.
 * @returns the status answer, or the failure that explains why there is none.
 */
function stateResult(root: string): RouteResult {
  const status = readIndexStatus(root)
  if (status !== undefined) return { code: 200, body: { ok: true, status } }
  if (existsSync(join(root, INDEX_STATUS_RELATIVE_PATH))) {
    // The file is there but the read or the shape check rejected it: corrupt, truncated, or written by
    // something other than an indexer. A rebuild is the only repair the panel can offer.
    return { code: 400, body: { ok: false, message: '索引状态文件无法解析，先跑一次 codegraph_index 重建' } }
  }
  return {
    code: 404,
    body: {
      ok: false,
      message: existsSync(join(root, GRAPH_RELATIVE_PATH))
        ? '这个工作区的索引由旧版本构建，没有状态摘要；先跑一次 codegraph_index 重建'
        : '这个工作区还没有索引，先跑一次 codegraph_index',
    },
  }
}

/**
 * Validate and rebuild one workspace's graph.
 *
 * The in-flight set is process-wide and keyed by the resolved root: two browser tabs, or one
 * double-clicked button, must not start two runs over the same files. The entry is dropped in a
 * `finally` so a failed run does not lock the workspace until restart.
 * @param ctx - the plugin context carrying `codegraph`.
 * @param req - the request whose body names the workspace.
 * @returns the reindex answer.
 */
async function reindexResult(ctx: Context, req: PanelRequest): Promise<RouteResult> {
  const read = await readJsonBody(req)
  if (!read.ok) return { code: 400, body: { ok: false, message: read.message } }
  const root = workspaceRoot(rootField(read.value))
  if (root === undefined) return invalidRoot()
  if (activeReindexes.has(root)) {
    return { code: 409, body: { ok: false, message: '这个工作区正在重建' } }
  }
  activeReindexes.add(root)
  try {
    const report = await ctx.codegraph.index(root)
    return {
      code: 200,
      body: { ok: true, message: `已重建：${report.filesIndexed} 文件 / ${report.nodeCount} 符号` },
    }
  } catch (error) {
    return { code: 500, body: { ok: false, message: String(error) } }
  } finally {
    activeReindexes.delete(root)
  }
}

/**
 * Read a JSON request body under the size cap.
 * @param req - the request to consume.
 * @returns the parsed value, or the one-line reason it cannot be used.
 */
async function readJsonBody(req: PanelRequest): Promise<BodyResult> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) return { ok: false, message: '请求体过大' }
    chunks.push(buffer)
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  } catch {
    return { ok: false, message: '请求体不是合法 JSON' }
  }
}

/**
 * The `root` member of a parsed request body, unvalidated.
 * @param body - whatever `JSON.parse` produced.
 * @returns the raw member, or `undefined` when the body is not an object.
 */
function rootField(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return undefined
  return (body as Record<string, unknown>).root
}

/**
 * Validate a browser-supplied workspace root.
 *
 * Only absolute paths to existing directories are accepted. That is not just an error check: it is
 * the entire allow-list for what this module can read, because everything after it is one constant
 * relative path. A NUL byte is rejected explicitly rather than left to `fs` — it can only appear in a
 * crafted target, and `fs` error text would otherwise become the panel's displayed message.
 * @param value - the raw query/body value.
 * @returns the trimmed absolute directory, or `undefined` when it is not one.
 */
function workspaceRoot(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const root = value.trim()
  if (root === '' || root.includes('\0') || !isAbsolute(root)) return undefined
  try {
    return statSync(root).isDirectory() ? root : undefined
  } catch {
    return undefined
  }
}

/** The one answer an invalid `root` gets, kept in one place so both routes phrase it alike. */
function invalidRoot(): RouteResult {
  return { code: 400, body: { ok: false, message: 'root 必须是一个存在的绝对路径' } }
}

/**
 * Write one JSON answer.
 * @param res - the response to write.
 * @param result - status and body.
 */
function respond(res: PanelResponse, result: RouteResult): void {
  res.statusCode = result.code
  // The data is a live snapshot of a directory the user is editing; a cached copy would be a lie.
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(result.body))
}
