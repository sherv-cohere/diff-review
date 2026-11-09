import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { ReviewComment, TurnSnapshot } from './types'

/** What a command printed, and whether standard output was cut at the buffer limit. */
export type Ran = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean }

const MAX_OUTPUT = 64 * 1024 * 1024

/** Set on processes diff-review starts, so their Claude Code hooks leave its state alone. */
export const INTERNAL_ENV = 'DIFF_REVIEW_INTERNAL'

export function run(argv: string[], options: { cwd: string; input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }): Promise<Ran> {
  const [command = '', ...args] = argv

  return new Promise(resolve => {
    const child = execFile(
      command,
      args,
      { cwd: options.cwd, maxBuffer: MAX_OUTPUT, timeout: options.timeoutMs ?? 120_000, env: options.env, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const isTruncated = error !== null && 'code' in error && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        const exitCode = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
        resolve({ exitCode, stdout, stderr: stderr || (error?.message ?? ''), isStdoutTruncated: isTruncated })
      },
    )
    if (options.input !== undefined) child.stdin?.end(options.input)
  })
}

/**
 * The files diff-review shares with the Claude Code hooks, kept per worktree in its git directory:
 * the comments not yet sent, the turns that changed files, the turn in progress, the files marked viewed, and
 * the last review point.
 */
export type StateFiles = { dir: string; comments: string; turns: string; pending: string; viewed: string; review: string }

export async function stateFiles(cwd: string): Promise<StateFiles | null> {
  const ran = await run(['git', 'rev-parse', '--absolute-git-dir'], { cwd })
  if (ran.exitCode !== 0) return null

  const dir = join(ran.stdout.trim(), 'diff-review')
  await mkdir(dir, { recursive: true })
  return { dir, comments: join(dir, 'comments.json'), turns: join(dir, 'turns.json'), pending: join(dir, 'pending.json'), viewed: join(dir, 'viewed.json'), review: join(dir, 'review.json') }
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

/** Writes through a temporary file and a rename, so a reader never sees half a file. */
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(value))
  await rename(temporary, path)
}

export async function removeFile(path: string): Promise<void> {
  await rm(path, { force: true })
}

/** The comments the prompt may reference, with the label of the diff they were made on. */
export type SharedComments = { label: string; comments: ReviewComment[] }

export type PendingTurn = { from: string; label: string }

/** The worktree as it was when comments were last sent to Claude, and those comments. */
export type ReviewPoint = { from: string; comments: ReviewComment[] }

export type { TurnSnapshot }
