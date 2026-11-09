import { text } from 'node:stream/consumers'

import { INTERNAL_ENV, type PendingTurn, readJson, removeFile, type ReviewPoint, type SharedComments, stateFiles, type TurnSnapshot, writeJson } from './bridge'
import { describeComments, Git } from './git'

const TURNS_KEPT = 30

/** What every comment token starts with, so a prompt without one is answered without reading any state. */
const TOKEN_START = '[#'

export type HookInput = { cwd: string; prompt?: string; session_id?: string }

/**
 * Claude Code's UserPromptSubmit hook, the one Claude waits for: returns the context that tells
 * Claude what each comment token in the prompt says, or null when the prompt carries none.
 */
export async function promptSubmit(input: HookInput): Promise<string | null> {
  const prompt = input.prompt ?? ''
  if (!prompt.includes(TOKEN_START)) return null

  const files = await stateFiles(input.cwd)
  if (files === null) return null

  const shared = await readJson<SharedComments>(files.comments, { label: '', comments: [] })
  const sent = shared.comments.filter(comment => prompt.includes(comment.token))
  if (sent.length === 0) return null

  const left = shared.comments.filter(comment => !sent.includes(comment))
  await writeJson(files.comments, { ...shared, comments: left } satisfies SharedComments)

  // What the code looked like as Claude got the comments, so "Since review" can show what changed in answer.
  const from = await new Git(input.cwd).snapshot()
  if (from !== null) await writeJson(files.review, { from, comments: sent } satisfies ReviewPoint)

  return describeComments(sent, shared.label)
}

/**
 * A background UserPromptSubmit hook: snapshots the worktree as a turn starts, so "Turn" mode also
 * catches files changed through Bash. Claude takes far longer to make its first edit than this takes.
 */
export async function turnStart(input: HookInput): Promise<void> {
  const files = await stateFiles(input.cwd)
  if (files === null) return

  // A prompt sent while a turn runs continues that turn.
  if ((await readJson<PendingTurn | null>(files.pending, null)) !== null) return

  const from = await new Git(input.cwd).snapshot()
  const label = (input.prompt ?? '').trim().split('\n')[0]?.slice(0, 60) || 'continued turn'
  if (from !== null) await writeJson(files.pending, { from, label } satisfies PendingTurn)
}

/** A background Stop hook: records the finished turn when it changed any file. */
export async function stop(input: HookInput): Promise<void> {
  const files = await stateFiles(input.cwd)
  if (files === null) return

  const pending = await readJson<PendingTurn | null>(files.pending, null)
  await removeFile(files.pending)
  if (pending === null) return

  const to = await new Git(input.cwd).snapshot()
  if (to === null || to === pending.from) return

  const turn: TurnSnapshot = { id: `${input.session_id ?? 'turn'}:${Date.now()}`, label: pending.label, from: pending.from, to }
  const turns = await readJson<TurnSnapshot[]>(files.turns, [])
  await writeJson(files.turns, [turn, ...turns].slice(0, TURNS_KEPT))
}

export async function runHook(name: string | undefined): Promise<void> {
  const input = JSON.parse(await text(process.stdin)) as HookInput
  // Claude runs started by diff-review itself, such as grouping, are not turns to review.
  if (process.env[INTERNAL_ENV] !== undefined) return

  if (name === 'prompt-submit') {
    const context = await promptSubmit(input)
    if (context !== null) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }))
  } else if (name === 'turn-start') await turnStart(input)
  else if (name === 'stop') await stop(input)
  else throw new Error(`unknown hook "${name}"; expected prompt-submit, turn-start or stop`)
}
