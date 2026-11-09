import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { readJson, type SharedComments, stateFiles } from '../src/bridge'
import { Controller } from '../src/controller'
import { Git } from '../src/git'
import { promptSubmit, stop, turnStart } from '../src/hooks'
import type { Line } from '../src/surface'
import type { Mode } from '../src/types'
import { createViewer, type Viewer } from '../src/viewer'

const COLUMNS = 140
const ROWS = 40

let repo: string
let typed: string[]

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
}

function write(path: string, text: string): void {
  writeFileSync(join(repo, path), text)
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'diff-review-'))
  // Options and groupings are cached per user; keep the tests' out of the real cache.
  process.env.XDG_CACHE_HOME = join(repo, '.cache-home')
  typed = []
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  write('a.ts', 'export const answer = 42\nexport const other = 1\n')
  git('add', '-A')
  git('commit', '-qm', 'first')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

/** The controller and viewer wired as the program wires them, drawing to an in-memory screen. */
async function open(mode?: Mode, columns = COLUMNS) {
  const files = await stateFiles(repo)
  if (files === null) throw new Error('not a repository')

  let viewer: Viewer | undefined
  const controller = new Controller(repo, files, {
    changed: () => undefined,
    toast: () => undefined,
    appendToPrompt: async text => void typed.push(text),
    leave: () => undefined,
    quit: () => undefined,
  })
  const surface = { columns, rows: ROWS, redraw: () => undefined }
  viewer = createViewer(controller.props(), surface, controller.actions)
  await controller.start(mode)

  const screen = (): Line[] => viewer.draw(controller.props())
  const text = () => screen().map(line => line.segs.map(seg => seg.t).join(''))
  return { controller, viewer, surface, screen, text }
}

function click(viewer: Viewer, x: number, y: number): void {
  viewer.pointer({ type: 'down', x, y, button: 'left' })
  viewer.pointer({ type: 'up', x, y, button: 'left' })
}

/** Clicks the line number of the new side's `needle` line, which starts a comment on it. */
function startComment(viewer: Viewer, lines: string[], needle: string): void {
  const row = rowOf(lines, needle)
  click(viewer, (lines[row] ?? '').indexOf('│') + 2, row)
}

function comment(viewer: Viewer, lines: string[], needle: string, body: string): void {
  startComment(viewer, lines, needle)
  viewer.key({ key: body })
  viewer.key({ key: 'return' })
}

function rowOf(lines: string[], needle: string): number {
  const row = lines.findIndex(line => line.includes(needle))
  if (row < 0) throw new Error(`"${needle}" is not on screen:\n${lines.join('\n')}`)
  return row
}

test('an uncommitted edit draws with syntax colours and the changed word marked', async () => {
  write('a.ts', 'export const answer = 43\nexport const other = 1\n')
  const { screen, text } = await open('worktree')

  const lines = text()
  expect(lines.some(line => line.includes('answer = 42'))).toBe(true)
  expect(lines.some(line => line.includes('answer = 43'))).toBe(true)

  const added = screen()[rowOf(lines, 'answer = 43')]
  const keyword = added?.segs.find(seg => seg.t.includes('const'))
  expect(keyword?.fg).toBeDefined()
  expect(added?.segs.find(seg => seg.t === '43')?.bg).not.toBe(added?.segs.find(seg => seg.t.includes('answer'))?.bg)
})

test('clicking a line and typing a comment shares it and types its token into Claude', async () => {
  write('a.ts', 'export const answer = 43\nexport const other = 1\n')
  const { viewer, text } = await open('worktree')

  comment(viewer, text(), 'answer = 43', 'why 43?')

  await vi.waitFor(() => expect(typed).toEqual(['[#1 a.ts:L1] ']))
  const files = await stateFiles(repo)
  const shared = await readJson<SharedComments>(files!.comments, { label: '', comments: [] })
  expect(shared.comments.map(comment => [comment.token, comment.text, comment.code])).toEqual([['[#1 a.ts:L1]', 'why 43?', 'export const answer = 43']])
})

test('a prompt carrying a token hands Claude the comment and the viewer drops it', async () => {
  write('a.ts', 'export const answer = 43\nexport const other = 1\n')
  const { viewer, text } = await open('worktree')
  comment(viewer, text(), 'answer = 43', 'why 43?')
  await vi.waitFor(() => expect(text().join('\n')).toContain('[#1 a.ts:L1]'))

  const context = await promptSubmit({ cwd: repo, prompt: 'fix [#1 a.ts:L1] please' })

  expect(context).toContain('a.ts, line 1 of the changed version')
  expect(context).toContain('export const answer = 43')
  expect(context).toContain('Comment: why 43?')
  await vi.waitFor(() => expect(text().join('\n')).not.toContain('why 43?'))
})

test('a same-size edit made in the second of the last commit still shows after that second passes', async () => {
  write('a.ts', 'export const answer = 43\nexport const other = 1\n')
  await new Promise(resolve => setTimeout(resolve, 1_100))

  const { text } = await open('worktree')

  expect(text().join('\n')).toContain('answer = 43')
})

test('a prompt without a token adds no context and keeps the comments', async () => {
  expect(await promptSubmit({ cwd: repo, prompt: 'hello' })).toBeNull()
})

test('a turn that changed files shows in Turn mode, including files Claude changed through the shell', async () => {
  await turnStart({ cwd: repo, prompt: 'add a constant' })
  write('b.ts', 'export const added = true\n')
  await stop({ cwd: repo, session_id: 's' })

  const { text } = await open('turn')

  const screen = text().join('\n')
  expect(screen).toContain('b.ts')
  expect(screen).toContain('export const added = true')
  expect(screen).not.toContain('a.ts')
})

test('a turn that changed nothing is not recorded', async () => {
  await turnStart({ cwd: repo, prompt: 'just a question' })
  await stop({ cwd: repo, session_id: 's' })

  const files = await stateFiles(repo)
  expect(await readJson(files!.turns, [])).toEqual([])
})

test('a turn ending reloads an open worktree view', async () => {
  const { text } = await open('worktree')
  expect(text().join('\n')).not.toContain('c.ts')

  await turnStart({ cwd: repo, prompt: 'add c' })
  write('c.ts', 'export const c = 3\n')
  await stop({ cwd: repo, session_id: 's' })

  await vi.waitFor(() => expect(text().join('\n')).toContain('export const c = 3'))
})

test('branch mode compares the work on a branch against main', async () => {
  git('checkout', '-qb', 'feature')
  write('a.ts', 'export const answer = 44\nexport const other = 1\n')
  git('commit', '-qam', 'feature work')
  write('d.ts', 'export const d = 4\n')

  const { text } = await open('branch')

  const screen = text().join('\n')
  expect(screen).toContain('Branch ▾  vs  main')
  expect(screen).toContain('answer = 44')
  expect(screen).toContain('export const d = 4')
})

test('every changed file shows in one scroll, each under its own header', async () => {
  write('a.ts', 'export const answer = 43\nexport const other = 1\n')
  write('e.ts', 'export const e = 5\n')

  const { text } = await open('worktree')

  const lines = text()
  expect(rowOf(lines, 'answer = 43')).toBeLessThan(rowOf(lines, 'export const e = 5'))
})

test('a comment on a long file in the all-files view names its real line and stays on screen', async () => {
  const numbered = (changed: number) => Array.from({ length: 40 }, (_, i) => `export const v${i + 1} = ${i + 1 === changed ? 'changed' : i + 1}\n`).join('')
  write('long.ts', numbered(0))
  git('add', '-A')
  git('commit', '-qm', 'long')
  write('long.ts', numbered(30))
  write('e.ts', 'export const e = 5\n')
  const { viewer, text } = await open('worktree')

  expect(text().join('\n')).not.toContain('v10 = 10')
  comment(viewer, text(), 'v30 = changed', 'why?')

  await vi.waitFor(() => expect(typed).toEqual(['[#1 long.ts:L30] ']))
  await vi.waitFor(() => expect(text().join('\n')).toContain('why?'))
  expect(text().join('\n')).toContain('export const e = 5')
})

test('commit mode shows what the last commit changed', async () => {
  write('a.ts', 'export const answer = 45\nexport const other = 1\n')
  git('commit', '-qam', 'second')

  const { text } = await open('commit')

  const screen = text().join('\n')
  expect(screen).toContain('answer = 42')
  expect(screen).toContain('answer = 45')
})

test('a hook and the viewer snapshotting at the same moment both get the worktree', async () => {
  write('a.ts', 'export const answer = 43\nexport const other = 1\n')

  const trees = await Promise.all(Array.from({ length: 8 }, () => new Git(repo).snapshot()))

  expect(trees[0]).not.toBeNull()
  expect(new Set(trees).size).toBe(1)
})

test('a wide pane shows each view setting as a button that toggles it', async () => {
  write('a.ts', 'export const answer = 43\nexport const other = 1\n')
  const { controller, viewer, text } = await open('worktree')

  const bar = text()[0] ?? ''
  expect(bar).toContain(' Wrap ')
  expect(bar).not.toContain('View ▾')
  click(viewer, bar.indexOf(' Wrap ') + 1, 0)

  await vi.waitFor(() => expect(controller.props().options.wrap).toBe(true))
})

test('a narrow pane folds the view settings into the View select', async () => {
  write('a.ts', 'export const answer = 43\nexport const other = 1\n')
  const { text } = await open('worktree', 50)

  expect(text()[0]).toContain('View ▾')
  expect(text()[0]).not.toContain(' Wrap ')
})

test('editing a comment rewrites what it says and keeps the token already in the prompt', async () => {
  write('a.ts', 'export const answer = 43\nexport const other = 1\n')
  const { viewer, text } = await open('worktree')
  comment(viewer, text(), 'answer = 43', 'why 43?')
  await vi.waitFor(() => expect(text().join('\n')).toContain(' Edit '))

  const lines = text()
  const row = rowOf(lines, ' Edit ')
  click(viewer, (lines[row] ?? '').indexOf(' Edit ') + 1, row)
  for (const key of ['backspace', 'backspace', 'backspace', '4', '4', '?']) viewer.key({ key })
  viewer.key({ key: 'return' })

  const files = await stateFiles(repo)
  await vi.waitFor(async () => {
    const shared = await readJson<SharedComments>(files!.comments, { label: '', comments: [] })
    expect(shared.comments.map(comment => [comment.token, comment.text])).toEqual([['[#1 a.ts:L1]', 'why 44?']])
  })
  expect(typed).toEqual(['[#1 a.ts:L1] '])
  expect(text().join('\n')).not.toContain('why 43?')
})

test('a file opened from the all-files view shows alone until Escape goes back to every file', async () => {
  write('a.ts', 'export const answer = 43\nexport const other = 1\n')
  write('e.ts', 'export const e = 5\n')
  const { controller, viewer, text } = await open('worktree')
  expect(controller.props().file?.segments).toBeDefined()

  click(viewer, 3, rowOf(text(), 'e.ts  +1'))
  await vi.waitFor(() => expect(controller.props().file?.path).toBe('e.ts'))
  expect(text().join('\n')).toContain('All files')
  expect(text().join('\n')).not.toContain('answer = 43')

  viewer.key({ key: 'escape' })
  await vi.waitFor(() => expect(controller.props().file?.segments).toBeDefined())
  expect(text().join('\n')).toContain('answer = 43')
})

test('files .gitattributes marks generated or not to diff stay out of the review', async () => {
  write('.gitattributes', 'gen/** linguist-generated=true\ngen/kept.ts -linguist-generated\n*.lock -diff\n')
  git('add', '-A')
  git('commit', '-qm', 'attributes')
  mkdirSync(join(repo, 'gen'))
  write('gen/api.ts', 'export const generated = 1\n')
  write('gen/kept.ts', 'export const handWritten = 1\n')
  write('deps.lock', 'pinned\n')
  write('a.ts', 'export const answer = 43\nexport const other = 1\n')

  const { controller, text } = await open('worktree')

  expect(controller.props().files.map(file => file.path)).toEqual(['a.ts', 'gen/kept.ts'])
  const screen = text().join('\n')
  expect(screen).toContain('answer = 43')
  expect(screen).toContain('handWritten')
  expect(screen).not.toContain('api.ts')
  expect(screen).not.toContain('pinned')
})

test('a long group title wraps in the file tree and keeps its file count in view', async () => {
  write('a.ts', 'export const answer = 43\nexport const other = 1\n')
  write('e.ts', 'export const e = 5\n')
  mkdirSync(join(repo, '.cache-home', 'diff-review'), { recursive: true })
  write('.cache-home/diff-review/options.json', JSON.stringify({ groupedModes: ['worktree'] }))
  const title = 'Answer constant bumped alongside the new export module'
  const groups = [{ title, why: 'Both constants.', paths: ['a.ts', 'e.ts'] }]
  write('.cache-home/diff-review/groupings.json', JSON.stringify([{ key: 'earlier', repo, groups, usedAt: 1 }]))

  const { text } = await open('worktree')

  const tree = text().map(line => line.slice(line.lastIndexOf('│') + 1))
  const header = tree.findIndex(line => line.includes('▾ Answer'))
  expect(header).toBeGreaterThan(0)
  expect(tree[header]?.trimEnd().endsWith(' 2')).toBe(true)
  const shown = tree.slice(header, header + 3).map(line => line.replace(/[▾\d]/g, '').trim()).join(' ')
  expect(shown).toContain(title)
})

test('while Haiku groups the files the tree says so, then shows the groups', async () => {
  write('a.ts', 'export const answer = 43\nexport const other = 1\n')
  write('e.ts', 'export const e = 5\n')
  mkdirSync(join(repo, '.cache-home', 'diff-review'), { recursive: true })
  write('.cache-home/diff-review/options.json', JSON.stringify({ groupedModes: ['worktree'] }))
  // Stands in for Claude Code, answering only once the test has seen the wait.
  const bin = join(repo, '.bin')
  mkdirSync(bin)
  write('.bin/claude', `#!/bin/sh\ncat > /dev/null\nwhile [ ! -f "${join(repo, '.answer')}" ]; do sleep 0.05; done\necho '{"groups":[{"title":"Constants","why":"Both.","files":[1,2]}]}'\n`)
  chmodSync(join(bin, 'claude'), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`

  try {
    const { text } = await open('worktree')
    // Starting the stand-in process can take a while when the whole suite runs at once.
    await vi.waitFor(() => expect(text().join('\n')).toContain('Grouping with Haiku'), { timeout: 5_000 })
    expect(text()[0]).toContain('Grouping ')

    write('.answer', '')
    await vi.waitFor(() => expect(text().join('\n')).toContain('▾ Constants'), { timeout: 5_000 })
    expect(text().join('\n')).not.toContain('Grouping with Haiku')
  } finally {
    process.env.PATH = path
  }
})

test('branch mode on a stacked branch compares against the branch below it in the stack', async () => {
  git('checkout', '-qb', 'lower')
  write('a.ts', 'export const answer = 44\nexport const other = 1\n')
  git('commit', '-qam', 'lower work')
  git('checkout', '-qb', 'upper')
  write('u.ts', 'export const upper = true\n')
  git('add', '-A')
  git('commit', '-qm', 'upper work')
  const stacks = { schemaVersion: 1, stacks: [{ trunk: { branch: 'main' }, branches: [{ branch: 'lower' }, { branch: 'upper' }] }] }
  write('.git/gh-stack', JSON.stringify(stacks))

  const { text } = await open('branch')

  const screen = text().join('\n')
  expect(screen).toContain('vs  lower')
  expect(screen).toContain('export const upper = true')
  expect(screen).not.toContain('answer = 44')
})

test('a file marked viewed folds to its header, stays viewed on reopening, and unfolds once it changes again', async () => {
  write('a.ts', 'export const answer = 43\nexport const other = 1\n')
  write('e.ts', 'export const e = 5\n')
  const first = await open('worktree')
  expect(first.text().join('\n')).toContain('answer = 43')

  first.viewer.key({ key: 'x' })
  await vi.waitFor(() => expect(first.text().join('\n')).not.toContain('answer = 43'))
  expect(first.text().join('\n')).toContain('✓ Viewed')
  expect(first.text().join('\n')).toContain('export const e = 5')

  const reopened = await open('worktree')
  expect(reopened.text().join('\n')).not.toContain('answer = 43')

  write('a.ts', 'export const answer = 44\nexport const other = 1\n')
  const changed = await open('worktree')
  expect(changed.text().join('\n')).toContain('answer = 44')
})

test('since review shows what changed after comments were sent, and whether each one\'s lines changed', async () => {
  write('a.ts', 'export const answer = 43\nexport const other = 1\n')
  const { viewer, text } = await open('worktree')
  comment(viewer, text(), 'answer = 43', 'why 43?')
  await vi.waitFor(() => expect(text().join('\n')).toContain('[#1 a.ts:L1]'))
  comment(viewer, text(), 'other = 1', 'fine as is')
  await vi.waitFor(() => expect(typed).toEqual(['[#1 a.ts:L1] ', '[#2 a.ts:L2] ']))

  await promptSubmit({ cwd: repo, prompt: 'fix [#1 a.ts:L1] [#2 a.ts:L2]' })
  write('a.ts', 'export const answer = 44\nexport const other = 1\n')
  const review = await open('review')

  const screen = review.text().join('\n')
  expect(screen).toContain('answer = 44')
  expect(screen).not.toContain('answer = 42')
  expect(screen).toMatch(/Sent · \[#1 a\.ts:L1\][\s\S]*lines changed since/)
  expect(screen).toMatch(/Sent · \[#2 a\.ts:L2\][\s\S]*not changed yet/)
  expect(screen).not.toContain(' Edit ')
})

test('since review before any comments were sent says how it works', async () => {
  const { text } = await open('review')

  expect(text().join('\n')).toContain('No comments sent yet')
})

test('a turn ending keeps the reader at the file they were reading in the all-files view', async () => {
  const lines = (name: string) => Array.from({ length: 60 }, (_, i) => `export const ${name}${i} = ${i}\n`).join('')
  write('a.ts', lines('a'))
  write('b.ts', lines('b'))
  const { controller, viewer, text } = await open('worktree')
  text()
  viewer.key({ key: 'J' })
  expect(text()[0]).toContain('2/2  A b.ts')

  await turnStart({ cwd: repo, prompt: 'add c' })
  write('c.ts', 'export const c = 3\n')
  await stop({ cwd: repo, session_id: 's' })

  await vi.waitFor(() => expect(controller.props().file?.segments).toHaveLength(3))
  const screen = text()
  expect(screen.join('\n')).toContain('c.ts')
  expect(screen[0]).toContain('2/3  A b.ts')
})

const PHONE_COLUMNS = 49
const SAVED_PANE_COLUMNS = 86
const LONG_FILE = `${Array.from({ length: 60 }, (_, i) => `export const line${i} = ${i}`).join('\n')}\n`

function showsCommentBox(lines: string[]): boolean {
  return lines.some(line => line.includes('Write a comment…'))
}

test('a phone-width pane shows one wrapped column with no tree or sideways scrollbar', async () => {
  const long = `export const answer = '${'x'.repeat(60)}-the-end'`
  write('a.ts', `${long}\nexport const other = 1\n`)
  const { text } = await open('worktree', PHONE_COLUMNS)

  const lines = text()
  expect(lines.some(line => line.includes('the-end'))).toBe(true)
  expect(lines.some(line => line.includes('│'))).toBe(false)
  expect(lines.some(line => line.includes('Filter'))).toBe(false)
  expect(lines.some(line => line.startsWith(' ◂ ') && line.endsWith(' ▸ '))).toBe(false)
})

test('a regular pane keeps the tree and the side-by-side columns', async () => {
  write('a.ts', 'export const answer = 43\nexport const other = 1\n')
  const { text } = await open('worktree', SAVED_PANE_COLUMNS)

  const lines = text()
  const row = lines[rowOf(lines, 'answer = 43')] ?? ''
  expect(row).toContain('answer = 42')
  expect(lines.some(line => line.includes('Filter'))).toBe(true)
})

test('the same reviewer changes layout when its pane is resized to phone width and back', async () => {
  write('a.ts', 'export const answer = 43\nexport const other = 1\n')
  const { surface, text } = await open('worktree', SAVED_PANE_COLUMNS)

  surface.columns = PHONE_COLUMNS
  expect(text()[rowOf(text(), 'answer = 43')]).not.toContain('answer = 42')

  surface.columns = SAVED_PANE_COLUMNS
  expect(text()[rowOf(text(), 'answer = 43')]).toContain('answer = 42')
})

test('the keys for layout options leave the saved options alone at phone width', async () => {
  write('a.ts', 'export const answer = 43\nexport const other = 1\n')
  const { controller, viewer, text } = await open('worktree', PHONE_COLUMNS)
  const before = controller.props().options

  text()
  for (const key of ['s', 't', 'w', '/']) viewer.key({ key })
  viewer.key({ key: 'escape' })

  expect(controller.props().options).toEqual(before)
})

test('at phone width the file counter opens a filtered list that jumps to the chosen file', async () => {
  write('a.ts', LONG_FILE)
  write('z.ts', LONG_FILE)
  const { viewer, text } = await open('worktree', PHONE_COLUMNS)

  const counterRow = rowOf(text(), '1/2')
  click(viewer, (text()[counterRow] ?? '').indexOf('1/2'), counterRow)
  viewer.key({ key: 'z' })

  const picked = text()
  expect(picked.slice(rowOf(picked, 'Files')).some(line => line.includes('a.ts'))).toBe(false)
  click(viewer, 4, rowOf(picked, 'z.ts'))

  await vi.waitFor(() => expect(text().find(line => line.includes('2/2'))).toContain('z.ts'))
})

test('a long path in the all-files view leaves its Viewed button on screen at phone width', async () => {
  mkdirSync(join(repo, 'a-rather-long-folder/with-another-long-folder'), { recursive: true })
  const path = 'a-rather-long-folder/with-another-long-folder/some_long_file_name_test.ts'
  write(path, 'export const one = 1\n')
  const { text } = await open('worktree', PHONE_COLUMNS)

  const header = text().find(line => line.includes('some_long_file_name_test.ts') && line.includes('Viewed'))
  expect(header).toBeDefined()
})

test('at phone width a second tap extends the comment, and its button sends it', async () => {
  write('a.ts', 'const one = 1\nconst two = 2\nconst three = 3\n')
  const { viewer, text } = await open('worktree', PHONE_COLUMNS)

  click(viewer, 12, rowOf(text(), 'one = 1'))
  click(viewer, 12, rowOf(text(), 'three = 3'))
  viewer.key({ key: 'all three' })
  const lines = text()
  const button = rowOf(lines, ' Comment ')
  click(viewer, (lines[button] ?? '').indexOf(' Comment ') + 1, button)

  await vi.waitFor(() => expect(typed).toEqual(['[#1 a.ts:L1-3] ']))
})

test('at regular width a second click moves the comment to that line', async () => {
  write('a.ts', 'const one = 1\nconst two = 2\nconst three = 3\n')
  const { viewer, text } = await open('worktree')

  startComment(viewer, text(), 'one = 1')
  startComment(viewer, text(), 'three = 3')

  expect(text().some(line => line.includes('New comment · L3'))).toBe(true)
})

test('the comment box comes back into view when the keyboard shrinks the pane', async () => {
  write('a.ts', LONG_FILE)
  const { viewer, surface, text } = await open('worktree', PHONE_COLUMNS)

  text()
  click(viewer, 12, ROWS - 3)
  expect(showsCommentBox(text())).toBe(true)

  surface.rows = 24
  expect(showsCommentBox(text())).toBe(true)
})

test('an open comment box can be scrolled away to read the code', async () => {
  write('a.ts', LONG_FILE)
  const { viewer, text } = await open('worktree', PHONE_COLUMNS)

  text()
  click(viewer, 12, 6)
  expect(showsCommentBox(text())).toBe(true)

  viewer.wheel(10, 5, 'vertical')

  expect(showsCommentBox(text())).toBe(false)
})
