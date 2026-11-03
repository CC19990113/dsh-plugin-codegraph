/**
 * dsh-plugin-codegraph-panel · 宿主端入口（空实现）
 *
 * 为什么需要它：cordis loader 按包的宿主入口加载一行插件，插件列表里那颗「运行中 / 未运行」
 * 的指示灯就是这一步的结论。本包只有浏览器半边——`lib/client.js` 是给
 * `window.__ModuleLoader__` 的 CJS factory，在 Node 里一 import 就碰 `window` 直接抛错——
 * 所以宿主入口必须是一个能 import、什么都不做的空模块。没有它，整行就是「未运行」。
 *
 * 浏览器半边不靠这个入口：它由 package.json 的 `dsh.client` 声明发现，宿主把客户端模块
 * 下发给浏览器，和这里无关。宿主侧真正提供数据的是 `packages/tool/src/panel.ts` 注册的
 * `/dsh-plugin-codegraph/api/*` 路由。
 * @module dsh-plugin-codegraph-panel/host
 */

/**
 * Host plugin body — this package has no host-side behavior.
 */
export function apply() {
  // Intentionally empty. The package exists for its browser half; this function only makes the
  // package loadable so the loader can report it as running.
}
