/**
 * The last `/codegraph` command each agent ran, kept in memory so the prompt can say so.
 *
 * A slash command is executed "without sending it to the model" — the host logs `command/run` and
 * `command/done` in the session, but neither event projects into the model's messages. That is the
 * right default for a shell-like command, and the wrong one for this plugin: after
 * `/codegraph index` the model is the next thing that wants to know the graph changed, and after
 * `/codegraph files <pattern>` the user already saw an answer the model never did. One line in the
 * prompt closes that gap without turning the command into a model turn.
 *
 * Deliberately small and process-local: one entry per agent, overwritten, and ignored once it is
 * stale. Nothing here is authoritative — the index sidecar remains the source of truth about the
 * graph itself; this only carries "the user just asked something".
 * @module dsh-plugin-codegraph-tool/command-log
 */

/** How long a recorded command keeps appearing in the prompt. */
export const COMMAND_LOG_WINDOW_MS = 10 * 60 * 1000

/** One settled `/codegraph` invocation, as the prompt needs it. */
export interface CommandRun {
  /** The subcommand and its argument, trimmed — what the user typed after `/codegraph`. */
  readonly input: string
  /** The text the command printed back to the user. */
  readonly text: string
  /** Whether the command settled successfully. */
  readonly ok: boolean
  /** Epoch milliseconds the command settled. */
  readonly at: number
}

/** Per-agent last-run memory, keyed by agent id. Bounded so a long-lived host cannot grow it forever. */
const runs = new Map<string, CommandRun>()

/** Cap on remembered agents; the oldest entry is dropped once it is reached. */
const MAX_AGENTS = 200

/**
 * Remember one settled command for an agent.
 * @param agentId - the agent the command ran for.
 * @param run - what it printed and whether it succeeded.
 */
export function recordCommandRun(agentId: string, run: CommandRun): void {
  if (agentId === '') return
  runs.delete(agentId)
  runs.set(agentId, run)
  while (runs.size > MAX_AGENTS) {
    // The map is over its cap, so it is not empty: the first key always exists.
    const [oldest] = runs.keys()
    runs.delete(oldest as string)
  }
}

/**
 * The command to mention in this agent's prompt, if one ran recently enough to matter.
 * @param agentId - the agent whose assembly is being written, or `undefined` when the host passed none.
 * @param now - the assembly's clock, injectable for tests.
 * @returns the recent run, or `undefined` when there is none or it is stale.
 */
export function recentCommandRun(agentId: string | undefined, now: number = Date.now()): CommandRun | undefined {
  if (agentId === undefined) return undefined
  const run = runs.get(agentId)
  if (run === undefined) return undefined
  return now - run.at <= COMMAND_LOG_WINDOW_MS ? run : undefined
}

/**
 * The prompt line describing the last command, when one is recent enough to mention.
 *
 * Only the first line of the command's own output is carried: a `files` listing can be a screenful,
 * and the prompt's job is to tell the model that the user asked something and roughly what came
 * back — not to replay it. The model can run the tool itself for the full answer.
 * @param agentId - the agent whose assembly is being written.
 * @param now - the assembly's clock, injectable for tests.
 * @returns one sentence, or an empty string when there is nothing fresh to say.
 */
export function commandRunHint(agentId: string | undefined, now: number = Date.now()): string {
  const run = recentCommandRun(agentId, now)
  if (run === undefined) return ''
  const [first = ''] = run.text.split('\n')
  const clipped = first.length > 200 ? `${first.slice(0, 200)}…` : first
  const subject = `/codegraph ${run.input === '' ? 'status' : run.input}`
  return run.ok
    ? `In this session the user ran ${subject} and saw: ${clipped}`
    : `In this session the user ran ${subject} and it failed: ${clipped}`
}

/**
 * Drop every remembered run, for tests that need a clean process.
 */
export function clearCommandRuns(): void {
  runs.clear()
}
