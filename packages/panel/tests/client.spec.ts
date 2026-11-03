/**
 * 客户端半侧的单元测试。
 *
 * `lib/client.js` 是给浏览器 `window.__ModuleLoader__` 的 CJS factory，不能用 import 加载，
 * 所以这里用 `node:vm` 跑它：沙箱里给一个假的 `window.__ModuleLoader__.load` 收 spec、
 * 假的 `localStorage`、假的 `console`，再给 `require("react")` 一个记录型的 React，
 * 用「hooks 数组 + 重新调用组件函数」模拟 useState 的更新。
 *
 * 组件本身不依赖真实 DOM：`React.createElement` 只造 `{ type, props, children }` 对象，
 * 因此「点击」就是直接调 `props.onClick()`，断言的是它发出的 fetch 与渲染出来的树。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = resolve(here, '..', 'lib', 'client.js')
const SOURCE = readFileSync(CLIENT_PATH, 'utf8')

const STORAGE_KEY = 'codegraph.panel.root'
const API = '/dsh-plugin-codegraph/api'

type El = { type: string; props: Record<string, any>; children: any[] }

type FetchCall = { url: string; init: any }

interface FakeFetch {
  fn: (url: string, init?: any) => Promise<any>
  calls: FetchCall[]
}

/** 造一个记录型的 React：createElement 建裸树，useState 用 hooks 数组 + 重新渲染 */
function createHarness() {
  const hooks: unknown[] = []
  let cursor = 0
  const React = {
    createElement(type: string, props: any, ...children: any[]) {
      return { type, props: props ?? {}, children }
    },
    useState(initial: unknown) {
      const index = cursor++
      if (!(index in hooks)) {
        hooks[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial
      }
      const set = (next: unknown) => {
        hooks[index] = typeof next === 'function' ? (next as (prev: unknown) => unknown)(hooks[index]) : next
      }
      return [hooks[index], set]
    },
  }
  return {
    React,
    mount(Component: any) {
      return () => {
        cursor = 0
        return Component({})
      }
    },
  }
}

function makeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  const calls = { get: [] as string[], set: [] as Array<[string, string]> }
  const storage = {
    getItem(key: string) {
      calls.get.push(key)
      return data.has(key) ? data.get(key)! : null
    },
    setItem(key: string, value: string) {
      calls.set.push([key, value])
      data.set(key, value)
    },
    removeItem(key: string) {
      data.delete(key)
    },
  }
  return { storage, calls, data }
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

function makeFetch(handler: (url: string, init: any) => any): FakeFetch {
  const calls: FetchCall[] = []
  const fn = async (url: string, init?: any) => {
    calls.push({ url, init })
    return handler(url, init)
  }
  return { fn, calls }
}

interface SetupOptions {
  storage?: any
  omitStorage?: boolean
  registerThrows?: boolean
  injectThrows?: boolean
  console?: { warn: (...args: any[]) => void; error?: (...args: any[]) => void }
}

function setup(options: SetupOptions = {}) {
  const harness = createHarness()
  const loads: any[] = []
  const storage = options.storage ?? makeStorage().storage
  const consoleSpy = options.console ?? { warn: () => {} }
  const sandbox: any = {
    window: { __ModuleLoader__: { load: (spec: any) => loads.push(spec) } },
    console: consoleSpy,
  }
  if (options.omitStorage !== true) sandbox.localStorage = storage
  runInNewContext(SOURCE, sandbox, { filename: CLIENT_PATH })

  const spec = loads[0]
  const mod = spec.factory((name: string) => {
    if (name === 'react') return harness.React
    throw new Error('unexpected require: ' + name)
  })

  const injectCalls: string[] = []
  const injectResults: any[] = []
  const registerCalls: any[] = []
  const ctx = {
    slots: {
      inject(name: string, factory: () => any) {
        injectCalls.push(name)
        if (options.injectThrows) throw new Error('inject boom')
        const result = factory()
        injectResults.push(result)
        return result
      },
      register(params: any, Component: any) {
        if (options.registerThrows) throw new Error('register boom')
        registerCalls.push({ params, Component })
        return { dispose: () => {} }
      },
    },
  }
  mod.apply(ctx)

  const registered = registerCalls[0]
  return {
    spec,
    exports: mod,
    sandbox,
    storage,
    injectCalls,
    injectResults,
    registerCalls,
    params: registered && registered.params,
    Component: registered && registered.Component,
    render: registered ? harness.mount(registered.Component) : null,
  }
}

/** 深度遍历：数组/元素/文本都走一遍 */
function walk(node: any, visit: (el: El) => void): void {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node !== 'object') return
  if (typeof node.type === 'string' && node.props) visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

function findAll(tree: any, predicate: (el: El) => boolean): El[] {
  const hits: El[] = []
  walk(tree, (el) => {
    if (predicate(el)) hits.push(el)
  })
  return hits
}

function textOf(node: any): string {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return textOf(node.children)
}

function findInput(tree: any): El {
  return findAll(tree, (el) => el.type === 'input')[0]
}

function buttons(tree: any): El[] {
  return findAll(tree, (el) => el.type === 'button')
}

function buttonByText(tree: any, label: string): El {
  const hit = buttons(tree).find((el) => textOf(el).trim() === label)
  if (!hit) throw new Error('没有找到按钮：' + label + '，当前有：' + buttons(tree).map(textOf).join('|'))
  return hit
}

const STATUS = {
  indexedAt: Date.UTC(2026, 10, 3, 2, 37),
  filesIndexed: 12,
  filesMinified: 3,
  nodeCount: 34,
  edgeCount: 56,
  unresolvedCount: 7,
  unresolvedLikelyInternalCount: 2,
  languages: [
    { language: 'typescript', fileCount: 9 },
    { language: 'javascript', fileCount: 3 },
  ],
}

describe('客户端模块契约', () => {
  it('通过 window.__ModuleLoader__.load 注册一个 factory，导出 name/inject/apply', () => {
    const app = setup()
    expect(app.spec.id).toBe('dsh-plugin-codegraph-panel')
    expect(typeof app.spec.factory).toBe('function')
    expect(app.exports.name).toBe('codegraph-panel-client')
    expect(app.exports.inject).toEqual(['slots'])
    expect(typeof app.exports.apply).toBe('function')
  })

  it('注册 settings.section：name/id/order/label 都对，组件是函数', () => {
    const app = setup()
    expect(app.injectCalls).toEqual(['settings.section'])
    expect(app.registerCalls).toHaveLength(1)
    expect(app.params.name).toBe('settings.section')
    expect(app.params.id).toBe('codegraph')
    expect(app.params.order).toBe(30)
    expect(typeof app.params.label).toBe('function')
    expect(app.params.label()).toBe('代码图谱')
    expect(typeof app.Component).toBe('function')
  })

  it('register 抛错时只 warn，不把异常抛回宿主', () => {
    const warn = vi.fn()
    const app = setup({ registerThrows: true, console: { warn } })
    expect(app.registerCalls).toHaveLength(0)
    expect(app.injectResults).toEqual([null])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('注册 settings.section 失败')
  })

  it('slots.inject 抛错时只 warn，不把异常抛回宿主', () => {
    const warn = vi.fn()
    const app = setup({ injectThrows: true, console: { warn } })
    expect(app.registerCalls).toHaveLength(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('注入 settings.section 失败')
  })
})

describe('设置页组件', () => {
  it('初始渲染：标题、路径输入框（带 localStorage 里的旧值）、两个按钮', () => {
    const storage = makeStorage({ [STORAGE_KEY]: '/tmp/ws' })
    const app = setup({ storage: storage.storage })
    const tree = app.render()

    expect(tree.type).toBe('div')
    expect(textOf(tree)).toContain('代码图谱')
    expect(findInput(tree).props.value).toBe('/tmp/ws')
    expect(buttons(tree).map((el) => textOf(el).trim())).toEqual(['刷新', '重建索引'])
    expect(storage.calls.get).toContain(STORAGE_KEY)
  })

  it('没有存过路径时输入框为空，填路径会写回 localStorage', () => {
    const storage = makeStorage()
    const app = setup({ storage: storage.storage })
    let tree = app.render()
    expect(findInput(tree).props.value).toBe('')

    findInput(tree).props.onChange({ target: { value: '/tmp/工程 a' } })
    tree = app.render()
    expect(findInput(tree).props.value).toBe('/tmp/工程 a')
    expect(storage.calls.set).toContainEqual([STORAGE_KEY, '/tmp/工程 a'])
  })

  it('路径为空时点「刷新」不发请求，只提示填路径', async () => {
    const app = setup()
    const fetchMock = makeFetch(() => jsonResponse({ ok: true }))
    app.sandbox.fetch = fetchMock.fn

    let tree = app.render()
    await buttonByText(tree, '刷新').props.onClick()
    tree = app.render()

    expect(fetchMock.calls).toHaveLength(0)
    expect(textOf(tree)).toContain('填一个工作区路径')
  })

  it('路径只有空白也算没填', async () => {
    const storage = makeStorage({ [STORAGE_KEY]: '   ' })
    const app = setup({ storage: storage.storage })
    const fetchMock = makeFetch(() => jsonResponse({ ok: true }))
    app.sandbox.fetch = fetchMock.fn

    let tree = app.render()
    await buttonByText(tree, '刷新').props.onClick()
    tree = app.render()

    expect(fetchMock.calls).toHaveLength(0)
    expect(textOf(tree)).toContain('填一个工作区路径')
  })

  it('刷新：GET state?root=<编码后的路径>，并把 status 各字段渲染出来', async () => {
    const root = '/tmp/工程 a'
    const storage = makeStorage({ [STORAGE_KEY]: root })
    const app = setup({ storage: storage.storage })
    const fetchMock = makeFetch(() => jsonResponse({ ok: true, status: STATUS }))
    app.sandbox.fetch = fetchMock.fn

    let tree = app.render()
    await buttonByText(tree, '刷新').props.onClick()
    tree = app.render()

    expect(fetchMock.calls).toHaveLength(1)
    expect(fetchMock.calls[0].url).toBe(API + '/state?root=' + encodeURIComponent(root))
    expect(fetchMock.calls[0].init).toBeUndefined()

    const text = textOf(tree)
    expect(text).toContain('文件')
    expect(text).toContain('12')
    expect(text).toContain('声明 34')
    expect(text).toContain('关系 56')
    expect(text).toContain('未解析 7')
    expect(text).toContain('疑似内部缺口 2')
    expect(text).toContain('跳过生成文件 3')
    expect(text).toContain('索引时间')
    expect(text).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
    expect(text).toContain('语言分布')
    expect(text).toContain('typescript 9')
    expect(text).toContain('javascript 3')
  })

  it('刷新：status 没有 languages 时不出「语言分布」这一行', async () => {
    const storage = makeStorage({ [STORAGE_KEY]: '/tmp/ws' })
    const app = setup({ storage: storage.storage })
    const status = { ...STATUS, languages: undefined }
    const fetchMock = makeFetch(() => jsonResponse({ ok: true, status }))
    app.sandbox.fetch = fetchMock.fn

    let tree = app.render()
    await buttonByText(tree, '刷新').props.onClick()
    tree = app.render()

    expect(textOf(tree)).toContain('文件 12')
    expect(textOf(tree)).not.toContain('语言分布')
  })

  it('刷新失败（body.ok=false）显示后端 message，不抛', async () => {
    const storage = makeStorage({ [STORAGE_KEY]: '/tmp/ws' })
    const app = setup({ storage: storage.storage })
    const fetchMock = makeFetch(() =>
      jsonResponse({ ok: false, message: '这个工作区还没有索引，先跑一次 codegraph_index' }),
    )
    app.sandbox.fetch = fetchMock.fn

    let tree = app.render()
    await buttonByText(tree, '刷新').props.onClick()
    tree = app.render()

    expect(textOf(tree)).toContain('这个工作区还没有索引，先跑一次 codegraph_index')
    expect(buttonByText(tree, '刷新').props.disabled).toBe(false)
  })

  it('刷新失败（HTTP 500 且没有 message）显示 HTTP 状态码', async () => {
    const storage = makeStorage({ [STORAGE_KEY]: '/tmp/ws' })
    const app = setup({ storage: storage.storage })
    const fetchMock = makeFetch(() => ({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('不是 JSON')
      },
    }))
    app.sandbox.fetch = fetchMock.fn

    let tree = app.render()
    await buttonByText(tree, '刷新').props.onClick()
    tree = app.render()

    expect(textOf(tree)).toContain('HTTP 500')
  })

  it('刷新时网络异常收敛成错误文本，不冒泡', async () => {
    const storage = makeStorage({ [STORAGE_KEY]: '/tmp/ws' })
    const app = setup({ storage: storage.storage })
    const fetchMock = makeFetch(() => {
      throw new Error('network down')
    })
    app.sandbox.fetch = fetchMock.fn

    let tree = app.render()
    await expect(buttonByText(tree, '刷新').props.onClick()).resolves.toBeUndefined()
    tree = app.render()

    expect(textOf(tree)).toContain('请求失败：network down')
  })

  it('fetch 抛的不是 Error 对象时也能收敛成错误文本', async () => {
    const storage = makeStorage({ [STORAGE_KEY]: '/tmp/ws' })
    const app = setup({ storage: storage.storage })
    const fetchMock = makeFetch(() => {
      throw 'boom'
    })
    app.sandbox.fetch = fetchMock.fn

    let tree = app.render()
    await buttonByText(tree, '刷新').props.onClick()
    tree = app.render()

    expect(textOf(tree)).toContain('请求失败：boom')
  })

  it('200 但不是 JSON：不崩，提示宿主没返回状态', async () => {
    const storage = makeStorage({ [STORAGE_KEY]: '/tmp/ws' })
    const app = setup({ storage: storage.storage })
    const fetchMock = makeFetch(() => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json')
      },
    }))
    app.sandbox.fetch = fetchMock.fn

    let tree = app.render()
    await buttonByText(tree, '刷新').props.onClick()
    tree = app.render()

    expect(textOf(tree)).toContain('宿主没有返回索引状态')
  })

  it('重建索引：POST reindex、body 带 root，成功后显示 message 并顺手刷新状态', async () => {
    const root = '/tmp/ws'
    const storage = makeStorage({ [STORAGE_KEY]: root })
    const app = setup({ storage: storage.storage })
    const fetchMock = makeFetch((url) => {
      if (url === API + '/reindex') return jsonResponse({ ok: true, message: '已重建：12 文件 / 34 符号' })
      return jsonResponse({ ok: true, status: STATUS })
    })
    app.sandbox.fetch = fetchMock.fn

    let tree = app.render()
    await buttonByText(tree, '重建索引').props.onClick()
    tree = app.render()

    expect(fetchMock.calls).toHaveLength(2)
    expect(fetchMock.calls[0].url).toBe(API + '/reindex')
    expect(fetchMock.calls[0].init.method).toBe('POST')
    expect(fetchMock.calls[0].init.headers).toEqual({ 'content-type': 'application/json' })
    expect(fetchMock.calls[0].init.body).toBe(JSON.stringify({ root }))
    expect(fetchMock.calls[1].url).toBe(API + '/state?root=' + encodeURIComponent(root))

    const text = textOf(tree)
    expect(text).toContain('已重建：12 文件 / 34 符号')
    expect(text).toContain('文件 12')
  })

  it('重建索引失败：显示错误、按钮恢复可用、不抛', async () => {
    const storage = makeStorage({ [STORAGE_KEY]: '/tmp/ws' })
    const app = setup({ storage: storage.storage })
    const fetchMock = makeFetch(() => jsonResponse({ ok: false, message: '这个工作区正在重建' }))
    app.sandbox.fetch = fetchMock.fn

    let tree = app.render()
    await buttonByText(tree, '重建索引').props.onClick()
    tree = app.render()

    expect(fetchMock.calls).toHaveLength(1)
    expect(textOf(tree)).toContain('这个工作区正在重建')
    expect(buttonByText(tree, '重建索引').props.disabled).toBe(false)
  })

  it('重建成功但宿主没给 message 时用默认文案', async () => {
    const storage = makeStorage({ [STORAGE_KEY]: '/tmp/ws' })
    const app = setup({ storage: storage.storage })
    const fetchMock = makeFetch(() => jsonResponse({ ok: true }))
    app.sandbox.fetch = fetchMock.fn

    let tree = app.render()
    await buttonByText(tree, '重建索引').props.onClick()
    tree = app.render()

    expect(textOf(tree)).toContain('已重建索引')
  })

  it('请求进行中：按钮禁用、文案变「刷新中…」，重复点击被忽略', async () => {
    const storage = makeStorage({ [STORAGE_KEY]: '/tmp/ws' })
    const app = setup({ storage: storage.storage })
    let resolveFetch: (value: any) => void = () => {}
    const fetchMock = makeFetch(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve
        }),
    )
    app.sandbox.fetch = fetchMock.fn

    let tree = app.render()
    const pending = buttonByText(tree, '刷新').props.onClick()

    // onClick 同步跑到 await 前：busy 已置位、fetch 已发出
    expect(fetchMock.calls).toHaveLength(1)
    tree = app.render()
    expect(buttonByText(tree, '刷新中…').props.disabled).toBe(true)
    expect(buttonByText(tree, '重建索引').props.disabled).toBe(true)
    expect(textOf(tree)).toContain('读取状态中…')

    // 用新的（busy 非 null 的）渲染结果再点一次，应当被忽略
    await buttonByText(tree, '刷新中…').props.onClick()
    await buttonByText(tree, '重建索引').props.onClick()
    expect(fetchMock.calls).toHaveLength(1)

    resolveFetch(jsonResponse({ ok: true, status: STATUS }))
    await pending
    tree = app.render()
    expect(buttonByText(tree, '刷新').props.disabled).toBe(false)
    expect(textOf(tree)).toContain('文件 12')
  })

  it('重建进行中：文案变「重建中…」并提示等待，完成后恢复', async () => {
    const storage = makeStorage({ [STORAGE_KEY]: '/tmp/ws' })
    const app = setup({ storage: storage.storage })
    let resolveFirst: (value: any) => void = () => {}
    let requestCount = 0
    const fetchMock = makeFetch(() => {
      requestCount += 1
      if (requestCount === 1) {
        return new Promise((resolve) => {
          resolveFirst = resolve
        })
      }
      return jsonResponse({ ok: true, message: '已重建索引' })
    })
    app.sandbox.fetch = fetchMock.fn

    let tree = app.render()
    const pending = buttonByText(tree, '重建索引').props.onClick()

    expect(fetchMock.calls).toHaveLength(1)
    tree = app.render()
    expect(buttonByText(tree, '重建中…').props.disabled).toBe(true)
    expect(textOf(tree)).toContain('重建索引中，稍等…')

    resolveFirst(jsonResponse({ ok: true, message: '已重建：12 文件' }))
    await pending
    tree = app.render()
    expect(buttonByText(tree, '重建索引').props.disabled).toBe(false)
    expect(textOf(tree)).toContain('已重建：12 文件')
  })

  it('输入框回车触发刷新，其它键不触发', async () => {
    const root = '/tmp/ws'
    const storage = makeStorage({ [STORAGE_KEY]: root })
    const app = setup({ storage: storage.storage })
    const fetchMock = makeFetch(() => jsonResponse({ ok: true, status: STATUS }))
    app.sandbox.fetch = fetchMock.fn

    let tree = app.render()
    const preventDefault = vi.fn()
    await findInput(tree).props.onKeyDown({ key: 'Enter', preventDefault })
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(fetchMock.calls).toHaveLength(1)
    expect(fetchMock.calls[0].url).toBe(API + '/state?root=' + encodeURIComponent(root))

    tree = app.render()
    const preventDefaultAgain = vi.fn()
    await findInput(tree).props.onKeyDown({ key: 'a', preventDefault: preventDefaultAgain })
    expect(preventDefaultAgain).not.toHaveBeenCalled()
    expect(fetchMock.calls).toHaveLength(1)
  })

  it('路径为空时点「重建索引」同样只提示，不发 POST', async () => {
    const app = setup()
    const fetchMock = makeFetch(() => jsonResponse({ ok: true }))
    app.sandbox.fetch = fetchMock.fn

    let tree = app.render()
    await buttonByText(tree, '重建索引').props.onClick()
    tree = app.render()

    expect(fetchMock.calls).toHaveLength(0)
    expect(textOf(tree)).toContain('填一个工作区路径')
  })

  it('status 字段缺失或类型不对时按 0 / — 兜底，不崩', async () => {
    const storage = makeStorage({ [STORAGE_KEY]: '/tmp/ws' })
    const app = setup({ storage: storage.storage })
    const fetchMock = makeFetch(() =>
      jsonResponse({
        ok: true,
        status: { indexedAt: 0, filesIndexed: '不是数字', languages: [{}] },
      }),
    )
    app.sandbox.fetch = fetchMock.fn

    let tree = app.render()
    await buttonByText(tree, '刷新').props.onClick()
    tree = app.render()

    const text = textOf(tree)
    expect(text).toContain('文件 0')
    expect(text).toContain('声明 0')
    expect(text).toContain('索引时间 —')
    expect(text).toContain('? 0')
  })

  it('localStorage 读写都抛错时组件仍能渲染和交互', () => {
    const storage = {
      getItem() {
        throw new Error('denied')
      },
      setItem() {
        throw new Error('denied')
      },
    }
    const app = setup({ storage })
    let tree = app.render()
    expect(findInput(tree).props.value).toBe('')

    findInput(tree).props.onChange({ target: { value: '/tmp/x' } })
    tree = app.render()
    expect(findInput(tree).props.value).toBe('/tmp/x')
  })

  it('完全没有 localStorage 时也能渲染、输入不报错', () => {
    const app = setup({ omitStorage: true })
    let tree = app.render()
    expect(findInput(tree).props.value).toBe('')

    findInput(tree).props.onChange({ target: { value: '/tmp/x' } })
    tree = app.render()
    expect(findInput(tree).props.value).toBe('/tmp/x')
  })
})
