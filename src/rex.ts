import { basename, relative } from 'node:path'

import { run } from './bridge'

/** The Rex session and pane this process runs in, from the variables Rex sets in every terminal. */
export type RexPlace = { session: string; block: string }

export function rexPlace(): RexPlace | null {
  const session = process.env.REX_SESSION
  const block = process.env.REX_BLOCK
  return session === undefined || block === undefined ? null : { session, block }
}

type Process = { foreground?: { invoked_path?: string; argv0?: string; cwd?: string } }
type BlockList = { blocks: { block_id: string; window_id?: string; placement?: string }[] }

async function rex(args: string[], cwd: string) {
  return run(['rex', ...args], { cwd, timeoutMs: 10_000 })
}

async function foreground(session: string, block: string, cwd: string): Promise<Process['foreground'] | undefined> {
  const ran = await rex(['block', 'call', '-s', session, '-b', block, 'process'], cwd)
  if (ran.exitCode !== 0) return undefined
  return (JSON.parse(ran.stdout) as Process).foreground
}

function isInside(dir: string, root: string): boolean {
  const path = relative(root, dir)
  return !path.startsWith('..')
}

/** Whether Claude Code is the program in front in that pane, working inside `root`. */
export async function isClaudePane(session: string, block: string, root: string): Promise<boolean> {
  const program = await foreground(session, block, root)
  const name = basename(program?.invoked_path ?? program?.argv0 ?? '')
  return name === 'claude' && program?.cwd !== undefined && isInside(program.cwd, root)
}

/** The pane running Claude Code in this repository, preferring one in the same tab as `near`. */
export async function findClaudePane(place: RexPlace, root: string): Promise<string | null> {
  const ran = await rex(['block', 'ls', '-s', place.session, '--json'], root)
  if (ran.exitCode !== 0) return null

  const { blocks } = JSON.parse(ran.stdout) as BlockList
  const window = blocks.find(one => one.block_id === place.block)?.window_id
  const candidates = blocks
    .filter(one => one.block_id !== place.block && one.placement === 'placed')
    .sort((a, b) => Number(b.window_id === window) - Number(a.window_id === window))

  const isClaude = await Promise.all(candidates.map(candidate => isClaudePane(place.session, candidate.block_id, root)))
  return candidates.find((_, i) => isClaude[i])?.block_id ?? null
}

/** Types `text` into the pane, returning what Rex printed when it could not. */
export async function typeInto(session: string, block: string, text: string, cwd: string): Promise<string | null> {
  const ran = await rex(['send', '-s', session, '-b', block, text], cwd)
  return ran.exitCode === 0 ? null : ran.stderr.trim()
}

export async function focus(session: string, block: string, cwd: string): Promise<void> {
  await rex(['focus', '-s', session, block], cwd)
}

/**
 * Opens the reviewer in a new pane to the right of `beside`, with most of the width. The command runs
 * in the login shell's environment, since the PATH Rex itself has may not reach the `claude` that grouping runs.
 */
export async function openBeside(session: string, beside: string, argv: string[], cwd: string): Promise<boolean> {
  const args = ['split', '-s', session, '-b', beside, '--split=right', '--ratio', '60', '--label', 'diff-review', '-c', cwd, '--', ...argv]
  const ran = await rex(args, cwd)
  if (ran.exitCode !== 0) process.stderr.write(ran.stderr)
  return ran.exitCode === 0
}
