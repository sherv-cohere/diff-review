import { randomUUID } from 'node:crypto'
import { copyFile, rm, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'

import { type Ran, readJson, run } from './bridge'
import type { Change, Choice, FileEntry, FileStatus, ReviewComment, Row, Side } from './types'

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const DIFF = ['diff', '--no-color', '--no-ext-diff', '-M']
// Whole files as context, so a file's rows hold every line of both sides.
const WHOLE_FILE = '-U100000000'
// Files .gitattributes marks generated (the attribute GitHub collapses them by) or not to diff stay out of the review.
const HIDDEN = [':(top,exclude,attr:linguist-generated)', ':(top,exclude,attr:linguist-generated=true)', ':(top,exclude,attr:-diff)']

/** The trees a diff compares, the branch checked out, and what the second select shows. */
export type Range = { from: string; to: string; branch: string; target: string }

/** Every git command diff-review runs, in one repository. */
export class Git {
  readonly cwd: string

  constructor(cwd: string) {
    this.cwd = cwd
  }

  run(args: string[], env?: NodeJS.ProcessEnv): Promise<Ran> {
    return run(['git', '-c', 'core.quotePath=false', '--no-pager', ...args], { cwd: this.cwd, env: env === undefined ? undefined : { ...process.env, ...env } })
  }

  /** The command's output without its trailing newline, or null when it failed. */
  private async read(args: string[], env?: NodeJS.ProcessEnv): Promise<string | null> {
    const ran = await this.run(args, env)
    return ran.exitCode === 0 ? ran.stdout.trimEnd() : null
  }

  /**
   * Writes the whole worktree, untracked files included, as a tree object through a throwaway index
   * seeded from the real one, so the real index is untouched. The copy keeps the index's modification
   * time: git re-reads a file whose timestamp is not older than the index, and a fresh timestamp would
   * hide a same-size edit made in the second the index was last written.
   */
  async snapshot(): Promise<string | null> {
    const gitDir = await this.read(['rev-parse', '--absolute-git-dir'])
    if (gitDir === null) return null

    const real = join(gitDir, 'index')
    // Each snapshot gets its own index: a hook and the viewer often snapshot at once, and two
    // `git add` runs on one index fail on its lock file.
    const scratch = join(gitDir, `diff-review.${process.pid}.${randomUUID()}.index`)
    try {
      await copyFile(real, scratch)
      const { atime, mtime } = await stat(real)
      await utimes(scratch, atime, mtime)
    } catch {
      // A repository without commits or staged files has no index yet.
      await rm(scratch, { force: true })
    }

    const env = { GIT_INDEX_FILE: scratch }
    try {
      if ((await this.run(['add', '-A'], env)).exitCode !== 0) return null
      return await this.read(['write-tree'], env)
    } finally {
      await rm(scratch, { force: true })
    }
  }

  private async branch(): Promise<string> {
    return (await this.read(['rev-parse', '--abbrev-ref', 'HEAD'])) ?? 'HEAD'
  }

  private async tree(rev: string): Promise<string | null> {
    return this.read(['rev-parse', '-q', '--verify', `${rev}^{tree}`])
  }

  private async isCommit(rev: string): Promise<boolean> {
    return (await this.read(['rev-parse', '-q', '--verify', `${rev}^{commit}`])) !== null
  }

  /** The branch below this one in its `gh stack` stack, else origin's default branch, else main, else master. */
  private async defaultBase(): Promise<string> {
    const parent = await this.stackParent()
    if (parent !== null) return parent

    const remote = await this.read(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'])
    if (remote !== null) return remote
    return (await this.isCommit('main')) ? 'main' : 'master'
  }

  private async stackParent(): Promise<string | null> {
    const [dir, branch] = await Promise.all([this.read(['rev-parse', '--path-format=absolute', '--git-common-dir']), this.branch()])
    if (dir === null) return null

    // gh stack keeps its stacks in this file; reading it is instant, where `gh stack view` asks GitHub.
    const parent = stackParent(await readJson<unknown>(join(dir, 'gh-stack'), null), branch)
    return parent !== null && (await this.isCommit(parent)) ? parent : null
  }

  /** The uncommitted changes: HEAD against the worktree, or `worktree`, a tree of it already written. */
  async worktreeRange(worktree: string | null): Promise<Range | string> {
    const [to, branch, head] = await Promise.all([worktree ?? this.snapshot(), this.branch(), this.tree('HEAD')])
    if (to === null) return 'git could not read the worktree.'
    return { from: head ?? EMPTY_TREE, to, branch, target: '' }
  }

  /** Everything since the branch left `base`, uncommitted changes included. */
  async branchRange(base: string | null, worktree: string | null): Promise<Range | string> {
    // The snapshot is the slow part and doesn't depend on the base, so it starts first.
    const snapshot = worktree === null ? this.snapshot() : Promise.resolve(worktree)
    const target = base ?? (await this.defaultBase())
    if (!(await this.isCommit(target))) return `${target} is not a branch, tag or commit.`

    const [to, branch, mergeBase] = await Promise.all([snapshot, this.branch(), this.read(['merge-base', target, 'HEAD'])])
    const from = mergeBase === null ? null : await this.tree(mergeBase)
    if (to === null || from === null) return `git found no common history with ${target}.`
    return { from, to, branch, target }
  }

  /** One commit's own changes, its target the short hash and subject. */
  async commitRange(commit: string | null): Promise<Range | string> {
    const rev = commit ?? 'HEAD'
    if (!(await this.isCommit(rev))) return `${rev} is not a commit.`

    const [to, parent, branch, target] = await Promise.all([this.tree(rev), this.tree(`${rev}~1`), this.branch(), this.read(['log', '-1', '--format=%h %s', rev])])
    if (to === null) return `${rev} is not a commit.`
    return { from: parent ?? EMPTY_TREE, to, branch, target: target ?? rev }
  }

  /** The branch's own commits since the base, newest first; on the base itself, its recent history. */
  async commits(base: string | null): Promise<Choice[]> {
    const mergeBase = await this.read(['merge-base', base ?? (await this.defaultBase()), 'HEAD'])
    const ahead = mergeBase === null ? '' : ((await this.read(['rev-list', '-n', '1', `${mergeBase}..HEAD`])) ?? '')
    const range = ahead === '' ? 'HEAD' : `${mergeBase}..HEAD`
    return parseCommits((await this.read(['log', '-n', '100', '--format=%h %s', range])) ?? '')
  }

  /** Local and remote branches, most recently committed first, for the base picker. */
  async refs(): Promise<Choice[]> {
    return parseRefs((await this.read(['for-each-ref', '--sort=-committerdate', '--count=100', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'])) ?? '')
  }

  async listing(from: string, to: string): Promise<Listed> {
    const [raw, stats] = await Promise.all([this.diffRange(from, to, ['--raw', '--no-abbrev', '-z']), this.diffRange(from, to, ['--numstat', '-z'])])
    return parseListing(raw.stdout, stats.stdout)
  }

  /** One file's rows, whole; `oldPath` is where a renamed file came from. */
  async fileRows(from: string, to: string, path: string, oldPath: string | undefined): Promise<Row[]> {
    // Listed paths are relative to the repository's root, whatever directory git runs in.
    const paths = [oldPath, path].filter((one): one is string => one !== undefined).map(one => `:(top)${one}`)
    return parseRows((await this.run([...DIFF, WHOLE_FILE, from, to, '--', ...paths])).stdout)
  }

  /** Every changed file's hunks with `context` lines around each change. */
  hunks(from: string, to: string, context: number): Promise<Ran> {
    return this.diffRange(from, to, [`-U${context}`])
  }

  /** A diff of the whole range without the hidden files, reading their attributes from the tree compared against. */
  private diffRange(from: string, to: string, args: string[]): Promise<Ran> {
    return this.run([`--attr-source=${to}`, ...DIFF, ...args, from, to, '--', ...HIDDEN])
  }
}

type GhStackFile = { schemaVersion: number; stacks?: { branches?: { branch: string; pullRequest?: { merged?: boolean } }[] }[] }

/**
 * The nearest branch below `branch` in its stack whose PR isn't merged, from gh stack's state file;
 * null when no stack holds it, every branch below is merged, or the file's format is one this doesn't know.
 */
export function stackParent(file: unknown, branch: string): string | null {
  const known = file as GhStackFile | null
  if (known?.schemaVersion !== 1) return null

  for (const { branches = [] } of known.stacks ?? []) {
    const at = branches.findIndex(one => one.branch === branch)
    if (at < 0) continue
    const below = branches.slice(0, at).filter(one => one.pullRequest?.merged !== true)
    return below.at(-1)?.branch ?? null
  }

  return null
}

export function parseCommits(stdout: string): Choice[] {
  return stdout
    .split('\n')
    .filter(line => line !== '')
    .map(line => ({ id: line.slice(0, line.indexOf(' ')), label: line.slice(0, 100) }))
}

export function parseRefs(stdout: string): Choice[] {
  return stdout
    .split('\n')
    .filter(ref => ref !== '' && !ref.endsWith('/HEAD') && ref !== 'origin')
    .map(ref => ({ id: ref, label: ref }))
}

/** Each listed file's hunks in a whole-range diff, by its path; empty for a file without hunks, such as a binary one. */
export function splitByFile(diff: string, paths: string[]): Map<string, string> {
  const byFile = new Map<string, string>()
  for (const section of diff.split(/^(?=diff --git )/m)) {
    const header = section.slice(0, section.indexOf('\n'))
    const path = paths.find(one => header.endsWith(` b/${one}`))
    const hunks = section.indexOf('\n@@')
    if (path !== undefined) byFile.set(path, hunks < 0 ? '' : section.slice(hunks + 1))
  }

  return byFile
}

export type Listed = { files: FileEntry[]; oldPaths: Record<string, string> }

/**
 * Reads `git diff --raw --no-abbrev -z`, `:<mode> <mode> <old blob> <new blob> <status>\0<path>\0` with a
 * second path for renames and copies, and `--numstat -z` into the listed files.
 */
export function parseListing(raw: string, numstat: string): Listed {
  const statuses = new Map<string, Pick<FileEntry, 'status' | 'version'>>()
  const oldPaths: Record<string, string> = {}

  const fields = raw.split('\0')
  for (let i = 0; i < fields.length - 1; ) {
    const [, , oldBlob = '', newBlob = '', code = ''] = (fields[i] ?? '').split(' ')
    // Renames and copies carry a similarity score after their letter, as in R087.
    const kind = code[0]
    const isPair = kind === 'R' || kind === 'C'
    const path = fields[i + (isPair ? 2 : 1)] ?? ''
    if (kind === 'R') oldPaths[path] = fields[i + 1] ?? ''
    i += isPair ? 3 : 2

    const status: FileStatus = kind === 'R' || kind === 'A' || kind === 'D' ? kind : kind === 'C' ? 'A' : 'M'
    statuses.set(path, { status, version: `${oldBlob}..${newBlob}` })
  }

  const files: FileEntry[] = []
  const stats = numstat.split('\0')
  for (let i = 0; i < stats.length - 1; ) {
    const [added = '0', removed = '0', inline = ''] = (stats[i] ?? '').split('\t')
    const isRename = inline === ''
    const path = isRename ? (stats[i + 2] ?? '') : inline
    i += isRename ? 3 : 1

    const isBinary = added === '-'
    const { status = 'M', version = '' } = statuses.get(path) ?? {}
    files.push({ path, status, version, added: isBinary ? 0 : Number(added), removed: isBinary ? 0 : Number(removed), isBinary })
  }

  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), oldPaths }
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/** Reads a whole-file unified diff into one row per line of either side. */
export function parseRows(diff: string): Row[] {
  const rows: Row[] = []
  let oldLine = 0
  let newLine = 0
  let isInHunk = false

  for (const line of diff.split('\n')) {
    const hunk = HUNK_HEADER.exec(line)
    if (hunk !== null) {
      oldLine = Number(hunk[1]) || 1
      newLine = Number(hunk[2]) || 1
      isInHunk = true
      continue
    }
    if (!isInHunk) {
      continue
    }

    const body = line.slice(1)
    if (line.startsWith('+')) {
      rows.push({ kind: 'added', old: 0, new: newLine++, text: body })
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'removed', old: oldLine++, new: 0, text: body })
    } else if (line.startsWith(' ')) {
      rows.push({ kind: 'context', old: oldLine++, new: newLine++, text: body })
    }
  }

  return rows
}

/** Each run of changed rows: git writes a run's removed rows before its added ones. */
export function changeRanges(rows: Row[]): Change[] {
  const ranges: Change[] = []
  rows.forEach(({ kind }, index) => {
    if (kind === 'context') return
    const last = ranges[ranges.length - 1]
    const run = last !== undefined && last.end === index ? last : undefined
    if (run === undefined) ranges.push({ start: index, end: index + 1, removed: kind === 'removed' ? 1 : 0 })
    else {
      run.end = index + 1
      if (kind === 'removed') run.removed += 1
    }
  })

  return ranges
}

export type CommentDraft = { id: number; path: string; side: Side; startRow: number; endRow: number; text: string; quote?: string }

export function buildComment(rows: Row[], draft: CommentDraft): ReviewComment | null {
  const picked = rows.slice(draft.startRow, draft.endRow + 1).filter(row => (draft.side === 'new' ? row.kind !== 'removed' : row.kind !== 'added'))
  const numbers = picked.map(row => row[draft.side])
  const text = draft.text.trim()
  if (numbers.length === 0 || text === '') {
    return null
  }

  const start = Math.min(...numbers)
  const end = Math.max(...numbers)
  const range = start === end ? `L${start}` : `L${start}-${end}`
  const name = draft.path.split('/').pop() ?? draft.path
  const token = `[#${draft.id} ${name}:${range}${draft.side === 'old' ? ' old' : ''}]`
  const code = picked.slice(0, 40).map(row => row.text).join('\n')

  return { ...draft, text, start, end, token, code }
}

/** The text the model reads for the comments whose tokens the prompt carries. */
export function describeComments(comments: ReviewComment[], label: string): string {
  const blocks = comments.map(comment => {
    const lines = comment.start === comment.end ? `line ${comment.start}` : `lines ${comment.start}-${comment.end}`
    const version = comment.side === 'old' ? 'the version before the change' : 'the changed version'

    return [
      `${comment.token} ${comment.path}, ${lines} of ${version}:`,
      '```',
      comment.code,
      '```',
      ...(comment.quote === undefined ? [] : [`Highlighted in the rendered preview: "${comment.quote}"`]),
      `Comment: ${comment.text}`,
    ].join('\n')
  })

  return [`Code review comments on the diff (${label}), referenced in the prompt by their [#n …] tokens:`, ...blocks].join('\n\n')
}
