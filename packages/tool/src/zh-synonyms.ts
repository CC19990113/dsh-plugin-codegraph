/**
 * Chinese task words → the English identifiers a code graph is indexed under.
 *
 * `taskTerms` selects identifier-shaped words, and a Chinese sentence offers none: it arrives as one
 * unbroken run of Han characters, while every symbol it names in the code is English. This table is
 * the bridge between the two. It stays a plain lookup with no model call behind it, because term
 * expansion runs inside a single tool call whose searches are milliseconds; a classification step
 * would cost more than the queries it feeds, and would make the same task answer differently from one
 * run to the next.
 *
 * Entries match as substrings, because Chinese is written without spaces: `报表` has to be found
 * inside `修改报表页`, not as a token of its own.
 * @module dsh-plugin-codegraph-tool/zh-synonyms
 */

/**
 * The built-in vocabulary, keyed on the word as a task description spells it.
 *
 * Each candidate list is ordered most-likely-first: `expandTerms` spends a caller's remaining term
 * budget on the first reading of every matched word before the second reading of any, so the reading
 * at index 0 is the one that survives the tightest budget.
 */
export const ZH_SYNONYMS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  // The nouns a task names, and the ones a domain model is built from.
  ['报表', ['report']],
  ['统计', ['stat', 'stats']],
  ['图表', ['chart']],
  ['列表', ['list', 'table']],
  ['详情', ['detail']],
  ['表单', ['form']],
  ['弹窗', ['modal', 'dialog']],
  ['对话框', ['dialog', 'modal']],
  ['菜单', ['menu']],
  ['页面', ['page']],
  ['组件', ['component']],
  ['路由', ['route', 'router']],
  ['文件', ['file']],

  // Reading and driving a collection: `分页` names both the control and the query parameters behind it.
  ['分页', ['page', 'pageSize', 'pagination', 'current']],
  ['筛选', ['filter', 'search']],
  ['排序', ['sort', 'order']],
  ['搜索', ['search']],
  ['查询', ['query', 'search']],
  ['参数', ['param', 'params']],

  // Writes, which a task usually spells as a verb rather than a noun.
  ['新增', ['create', 'add']],
  ['删除', ['delete']],
  ['编辑', ['edit', 'update']],
  ['更新', ['update', 'edit']],
  ['导入', ['import']],
  ['导出', ['export']],
  ['上传', ['upload']],
  ['下载', ['download']],
  ['校验', ['validate', 'validation']],

  // Infrastructure a change to one feature usually reaches.
  ['权限', ['permission', 'auth']],
  ['配置', ['config', 'setting']],
  ['缓存', ['cache']],
  ['任务', ['task', 'job']],
  ['日志', ['log']],
  ['接口', ['api', 'request']],
  ['账户', ['account', 'user']],
  ['用户', ['user', 'account']],
  ['时间', ['time', 'date']],
  ['状态', ['status', 'state']],
  ['错误', ['error', 'exception']],
  ['加载', ['loading', 'load']],
  ['刷新', ['refresh', 'reload']],
  ['测试', ['test', 'spec']],
])

/**
 * Merge a deployment's vocabulary over the built-in table.
 *
 * A deployment extends a word rather than replacing it: its own reading is added after the generic
 * ones. That direction is deliberate — a synonym list can then only make a task match more, never
 * less, so installing a project's vocabulary cannot silently stop a reading that worked before.
 * @param extra - the deployment-supplied word → candidates map.
 * @returns every word's candidates, built-in readings first.
 */
function mergedTable(extra: Readonly<Record<string, readonly string[]>>): Map<string, readonly string[]> {
  const merged = new Map<string, readonly string[]>(ZH_SYNONYMS)
  for (const [word, candidates] of Object.entries(extra)) {
    const builtIn = merged.get(word) ?? []
    merged.set(word, [...builtIn, ...candidates])
  }
  return merged
}

/** One word found in a term, with where the term mentions it. */
interface Reading {
  /** Offset of the word inside the term, which orders the readings the way the task was written. */
  readonly at: number
  /** The English identifiers this word may stand for. */
  readonly candidates: readonly string[]
}

/**
 * Append the English identifiers the Chinese words in `terms` stand for.
 *
 * Candidates go after the terms they were read from, so the caller's own ranking is never reordered —
 * a task that is half English keeps its English identifiers in the positions `taskTerms` gave them.
 *
 * They are appended breadth-first: every matched word's first reading comes before any word's second.
 * A Chinese clause is a single term, so almost the whole budget a caller allows is spent here, and a
 * depth-first order would let one concept's fourth spelling crowd a second concept out of the answer
 * entirely — the report page's pagination would be searched for while its filters were not.
 * @param terms - the terms extracted from a task description, in the caller's order.
 * @param extra - deployment vocabulary, merged over the built-in table.
 * @returns `terms` followed by every candidate not already among them.
 */
export function expandTerms(
  terms: readonly string[],
  extra: Readonly<Record<string, readonly string[]>> = {},
): string[] {
  const table = mergedTable(extra)
  const seen = new Set(terms.map(term => term.toLowerCase()))
  const expanded = [...terms]
  for (const term of terms) {
    const readings: Reading[] = []
    for (const [word, candidates] of table) {
      const at = term.indexOf(word)
      if (at >= 0) readings.push({ at, candidates })
    }
    // The task's own word order decides which reading is searched for first; a stable sort keeps the
    // table's order for two words that start at the same offset.
    readings.sort((left, right) => left.at - right.at)
    const deepest = Math.max(0, ...readings.map(reading => reading.candidates.length))
    for (let rank = 0; rank < deepest; rank += 1) {
      for (const reading of readings) {
        const candidate = reading.candidates[rank]
        if (candidate === undefined) continue
        // A candidate the task already contained, or one a later word repeats (`用户` and `账户` both
        // read as `user`), must not become a second identical query.
        const key = candidate.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        expanded.push(candidate)
      }
    }
  }
  return expanded
}
