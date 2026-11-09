import { describe, expect, test } from 'vitest'

import { combineFiles } from '../src/all-files'
import { buildComment, changeRanges, parseListing, parseRows, stackParent } from '../src/git'
import { type CachedGrouping, closestGrouping, fitGroups, groupingPrompt, parseGroups, remember, splitDiff } from '../src/grouping'
import type { FileEntry, Listing, Row } from '../src/types'
import { type MdLine, renderMarkdown, spanWidth } from '../src/viewer/markdown'
import { C } from '../src/viewer/palette'
import { buildItems, withFiles } from '../src/viewer/model'
import { editText } from '../src/viewer/text'
import { buildTree } from '../src/viewer/tree'
import { wordRanges } from '../src/viewer/words'

const NEW_FILE = Array.from({ length: 10 }, (_, i) => (i === 4 ? 'const answer = 43' : `const line${i + 1} = ${i + 1}`))

const FILE_DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,10 +1,10 @@',
  ...NEW_FILE.slice(0, 4).map(line => ` ${line}`),
  '-const answer = 42',
  '+const answer = 43',
  ...NEW_FILE.slice(5).map(line => ` ${line}`),
  '',
].join('\n')

const ROWS = parseRows(FILE_DIFF)

describe('git output', () => {
  test('a whole-file diff becomes one row per line with both line numbers', () => {
    expect(ROWS.length).toBe(11)
    expect(ROWS[4]).toEqual({ kind: 'removed', old: 5, new: 0, text: 'const answer = 42' })
    expect(ROWS[5]).toEqual({ kind: 'added', old: 0, new: 5, text: 'const answer = 43' })
    expect(ROWS[10]).toEqual({ kind: 'context', old: 10, new: 10, text: 'const line10 = 10' })
  })

  test('change runs count their removed rows first', () => {
    expect(changeRanges(ROWS)).toEqual([{ start: 4, end: 6, removed: 1 }])
  })

  test('renames list under the new path and remember the old one, and each file carries its blobs', () => {
    const raw = [
      ':100644 100644 b1 b2 M', 'b.go',
      ':100644 100644 i1 i2 M', 'img.png',
      ':100644 100644 r1 r2 R087', 'old/a.go', 'new/a.go',
      '',
    ].join('\0')
    const listed = parseListing(raw, '3\t1\tb.go\0' + '2\t2\t\0old/a.go\0new/a.go\0' + '-\t-\timg.png\0')

    expect(listed.files).toEqual([
      { path: 'b.go', status: 'M', version: 'b1..b2', added: 3, removed: 1, isBinary: false },
      { path: 'img.png', status: 'M', version: 'i1..i2', added: 0, removed: 0, isBinary: true },
      { path: 'new/a.go', status: 'R', version: 'r1..r2', added: 2, removed: 2, isBinary: false },
    ])
    expect(listed.oldPaths).toEqual({ 'new/a.go': 'old/a.go' })
  })
})

describe('stacks', () => {
  const file = {
    schemaVersion: 1,
    stacks: [{ branches: [
      { branch: 'base-work', pullRequest: { merged: false } },
      { branch: 'landed', pullRequest: { merged: true } },
      { branch: 'mine' },
      { branch: 'above' },
    ] }],
  }

  test('a branch compares against the nearest branch below it whose PR is not merged', () => {
    expect(stackParent(file, 'mine')).toBe('base-work')
    expect(stackParent(file, 'above')).toBe('mine')
  })

  test('the bottom of a stack, an unstacked branch and an unknown format have no stack parent', () => {
    expect(stackParent(file, 'base-work')).toBeNull()
    expect(stackParent(file, 'elsewhere')).toBeNull()
    expect(stackParent({ ...file, schemaVersion: 2 }, 'mine')).toBeNull()
  })
})

describe('comments', () => {
  test('a comment on the new side is numbered by new lines and tokenized short', () => {
    const comment = buildComment(ROWS, { id: 7, path: 'src/a.ts', side: 'new', startRow: 3, endRow: 5, text: ' rename ' })

    expect(comment?.token).toBe('[#7 a.ts:L4-5]')
    expect(comment?.code).toBe('const line4 = 4\nconst answer = 43')
    expect(comment?.text).toBe('rename')
  })

  test('a comment on removed lines is numbered by the old file', () => {
    const comment = buildComment(ROWS, { id: 2, path: 'src/a.ts', side: 'old', startRow: 4, endRow: 4, text: 'why?' })

    expect(comment?.token).toBe('[#2 a.ts:L5 old]')
  })
})

describe('layout', () => {
  test('unchanged rows away from a change fold into an expandable gap', () => {
    const items = buildItems({ total: 11, changes: [{ start: 4, end: 6, removed: 1 }], revealed: new Uint8Array(11), layoutAt: () => 'unified', notes: [] })

    expect(items.filter(item => item.k === 'gap')).toEqual([{ k: 'gap', from: 9, to: 11 }])
    expect(items.filter(item => item.k === 'line').map(item => (item.k === 'line' ? item.row : -1))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
  })

  test('split layout pairs a removed row with the added row that replaced it', () => {
    const items = buildItems({ total: 11, changes: [{ start: 4, end: 6, removed: 1 }], revealed: new Uint8Array(11), layoutAt: () => 'split', notes: [] })

    expect(items).toContainEqual({ k: 'pair', left: 4, right: 5, part: 0 })
    expect(items).not.toContainEqual({ k: 'pair', left: 5, right: 5, part: 0 })
  })

  test('a comment box takes its rows right under the line it ends on', () => {
    const items = buildItems({ total: 11, changes: [{ start: 4, end: 6, removed: 1 }], revealed: new Uint8Array(11), layoutAt: () => 'unified', notes: [{ id: 3, side: 'new', endRow: 5, height: 4 }] })
    const at = items.findIndex(item => item.k === 'line' && item.row === 5)

    expect(items.slice(at + 1, at + 5)).toEqual([0, 1, 2, 3].map(part => ({ k: 'note', id: 3, part })))
  })

  test('the file tree joins single-child folders and filters by path', () => {
    const files: FileEntry[] = [
      { path: 'ax/cmd/ax/exec.go', status: 'M', version: '', added: 1, removed: 1, isBinary: false },
      { path: 'ax/cmd/ax/serve.go', status: 'M', version: '', added: 1, removed: 0, isBinary: false },
      { path: 'ax/internal/auth/auth.go', status: 'A', version: '', added: 7, removed: 0, isBinary: false },
    ]

    expect(buildTree(files, '', new Set()).map(row => row.name)).toEqual(['ax', 'cmd/ax', 'exec.go', 'serve.go', 'internal/auth', 'auth.go'])
    expect(buildTree(files, 'auth', new Set()).map(row => row.name)).toEqual(['ax/internal/auth', 'auth.go'])
  })
})

describe('all files', () => {
  const LONG_FILE = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
  const longRows = parseRows(['@@ -1,30 +1,30 @@', ...LONG_FILE.slice(0, 19).map(line => ` ${line}`), '-line 20', '+line twenty', ...LONG_FILE.slice(20).map(line => ` ${line}`), ''].join('\n'))
  const files: FileEntry[] = [
    { path: 'a.ts', status: 'M', version: '', added: 1, removed: 1, isBinary: false },
    { path: 'b.ts', status: 'M', version: '', added: 1, removed: 1, isBinary: false },
  ]

  test('each file keeps only its changed rows and their context, and every row maps back to its file', () => {
    const { file, places } = combineFiles('k', files, path => (path === 'a.ts' ? ROWS : longRows), () => [])

    expect(file.segments?.map(({ path, start, end }) => ({ path, start, end }))).toEqual([{ path: 'a.ts', start: 0, end: 9 }, { path: 'b.ts', start: 9, end: 17 }])
    expect(file.changes).toEqual([{ start: 4, end: 6, removed: 1 }, { start: 12, end: 14, removed: 1 }])
    expect(places[12]).toEqual({ path: 'b.ts', row: 19 })
  })

  test('rows a comment covers stay in the view even away from a change', () => {
    const { places } = combineFiles('k', files, path => (path === 'a.ts' ? ROWS : longRows), path => (path === 'b.ts' ? [[1, 1]] : []))

    expect(places).toContainEqual({ path: 'b.ts', row: 1 })
  })

  test('each file starts with a header, and a jump in line numbers folds', () => {
    const { file } = combineFiles('k', files, path => (path === 'a.ts' ? ROWS : longRows), () => [])
    const items = withFiles(buildItems({ total: file.rows.length, changes: file.changes, revealed: new Uint8Array(file.rows.length).fill(1), layoutAt: () => 'unified', notes: [] }), file.segments ?? [], i => file.rows[i])
    const kinds = items.map(item => (item.k === 'fold' ? `fold ${item.count}` : item.k === 'file' ? `file ${item.seg}` : item.k))

    expect(kinds.slice(0, 2)).toEqual(['file 0', 'line'])
    expect(kinds).toContain('file 1')
    expect(kinds[kinds.indexOf('file 1') + 1]).toBe('fold 16')
  })
})

describe('text editing', () => {
  const at = (text: string, cursor: number, key: string, mods: { meta?: true; ctrl?: true } = {}) => editText(text, cursor, { key, ...mods })

  test('Option+arrow jumps over a word and the punctuation before it', () => {
    expect(at('fix the bar, please', 19, 'left', { meta: true })?.cursor).toBe(13)
    expect(at('fix the bar, please', 11, 'right', { meta: true })?.cursor).toBe(19)
  })

  test('Option+Backspace deletes the word before the cursor', () => {
    expect(at('fix the bar', 11, 'backspace', { meta: true })).toEqual({ text: 'fix the ', cursor: 8 })
  })

  test('Cmd+Backspace, sent as Ctrl+U, deletes back to the start of the line only', () => {
    expect(at('first line\nsecond line', 22, 'u', { ctrl: true })).toEqual({ text: 'first line\n', cursor: 11 })
  })

  test('Cmd+arrow, sent as Home or End, stays on the current line', () => {
    expect(at('first line\nsecond line', 14, 'home')?.cursor).toBe(11)
    expect(at('first line\nsecond line', 3, 'end')?.cursor).toBe(10)
  })

  test('a key that neither moves nor deletes is left to the caller', () => {
    expect(at('text', 4, 'x')).toBeNull()
  })
})

describe('word diff', () => {
  test('only the changed word is marked when lines are mostly alike', () => {
    expect(wordRanges('const answer = 42', 'const answer = 43')).toEqual({ old: [[15, 17]], new: [[15, 17]] })
  })

  test('a whitespace-only change is marked', () => {
    expect(wordRanges('a = 1', 'a  = 1')).toEqual({ old: [[1, 2]], new: [[1, 3]] })
  })
})

describe('markdown preview', () => {
  const lineText = (line: MdLine) => line.spans.map(span => span.t).join('')

  const WIDE_TABLE = [
    '| Failure                                      | Behavior                                                                                                         | Blast radius                        |',
    '| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------- |',
    "| Desktop fails to start during a turn         | The agent start is cancelled and the turn fails. The next turn stops the failed desktop and starts it again      | That turn                           |",
    "| Desktop crashes while running                | The state goes to `failed` and open streams close. The next turn or `/desktop` call restarts it                  | Every viewer of that user's desktop |",
  ].join('\n')

  test('a table wider than the pane wraps its cells inside the width and keeps every word', () => {
    const lines = renderMarkdown(WIDE_TABLE, 70).map(lineText)

    expect(Math.max(...lines.map(line => line.length))).toBeLessThanOrEqual(70)
    expect(lines.filter(line => line.startsWith('┌') || line.startsWith('└')).length).toBe(2)
    for (const word of ['cancelled', 'restarts', 'desktop', 'radius']) expect(lines.join(' ')).toContain(word)
  })

  const mermaid = (statements: string[], width = 80) => renderMarkdown(['```mermaid', ...statements, '```'].join('\n'), width)
  const widestRow = (lines: MdLine[]) => Math.max(...lines.map(line => spanWidth(line.spans)))
  const hasRow = (lines: MdLine[], text: string) => lines.some(line => lineText(line).includes(text))

  test('a mermaid block draws as a diagram, in the direction it was written', () => {
    const lines = mermaid(['flowchart LR', '  viewer --> ax']).map(lineText)

    expect(lines.some(line => /│ viewer ├─+▶│ ax │/.test(line))).toBe(true)
  })

  test('a diagram too wide for the pane in any layout keeps its width and slides', () => {
    const targets = Array.from({ length: 6 }, (_, i) => `  hub --> n${i}[node number ${i}]`)
    const lines = mermaid(['flowchart TD', ...targets], 60)

    expect(lines.every(line => line.slides === true)).toBe(true)
    expect(widestRow(lines)).toBeGreaterThan(60)
  })

  test('a left-to-right flowchart too wide for the pane runs top-down instead', () => {
    const edges = Array.from({ length: 4 }, (_, i) => `  n${i}[node number ${i}] --> n${i + 1}[node number ${i + 1}]`)
    const lines = mermaid(['flowchart LR', ...edges], 60)

    expect(widestRow(lines)).toBeLessThanOrEqual(60)
    expect(lines.filter(line => lineText(line).includes('node number')).length).toBe(5)
  })

  test('a left-to-right state diagram too wide for the pane runs top-down too', () => {
    const lines = mermaid(['stateDiagram-v2', '  direction LR', '  Requested --> Approved', '  Approved --> Released', '  Released --> Archived'], 30)

    expect(widestRow(lines)).toBeLessThanOrEqual(30)
  })

  test('a labelled fan-out narrowed for the pane keeps its boxes in view and its labels under them', () => {
    const edges = ['  hub[Plugin Service] -->|release files| s3(S3Proxy)', '  hub -->|releases, selections, plans| db(PostgreSQL)', '  hub -->|read MCP targets| gw[Gateway]']
    const lines = mermaid(['flowchart LR', ...edges], 60)
    const rows = lines.map(lineText)

    expect(rows.findIndex(row => row.includes('Gateway'))).toBeGreaterThan(rows.findIndex(row => row.includes('Plugin Service')))
    expect(widestRow(lines)).toBeLessThanOrEqual(60)
    expect(rows).toContain('Plugin Service → PostgreSQL: releases, selections, plans')
  })

  test('a long edge label keeps every word', () => {
    const lines = mermaid(['flowchart LR', '  a[One] -->|publish releases, edit selections| b[Two]'], 120)

    expect(hasRow(lines, 'publish releases, edit selections')).toBe(true)
  })

  test('labelled edges into the same box each keep their label', () => {
    const lines = mermaid(['flowchart LR', '  a[One] -->|from one| c[Sink]', '  b[Two] -->|from two| c'], 120)

    expect(hasRow(lines, 'from one')).toBe(true)
    expect(hasRow(lines, 'from two')).toBe(true)
  })

  test('an edge label with no room on the drawing is listed under it, naming the edge', () => {
    const label = 'a label far too long for the space the layout keeps between two columns'
    const lines = mermaid(['flowchart LR', `  a[One] -->|${label}| b[Two]`], 200).map(lineText)

    expect(lines.at(-1)).toBe(`One → Two: ${label}`)
  })

  test('a note under a diagram wraps to the pane and stays put while the diagram slides', () => {
    const label = 'a label far too long for the space the layout keeps between two columns'
    const lines = mermaid(['flowchart TD', '  a[One] -->|fits| b[Two]', `  a -->|${label}| c[Three]`, '  a -->|also fits| d[Four]'], 40)
    const notes = lines.filter(line => line.slides !== true)

    expect(notes.length).toBeGreaterThan(1)
    expect(widestRow(notes)).toBeLessThanOrEqual(40)
    expect(notes.map(lineText).join(' ').replace(/\s+/g, ' ')).toContain(label)
  })

  test('an edge skipping a rank goes around a neighbouring box instead of behind it', () => {
    const lines = mermaid(['flowchart TD', '  a[Top] --> b[Left]', '  a --> c[Right]', '  b --> d[Next]', '  b --> e[Last]', '  d --> e']).map(lineText)

    expect(lines.find(line => line.includes('Left') && line.includes('Right'))).not.toMatch(/├─+│ *Right/)
  })

  test('a quoted edge label may hold a line break', () => {
    expect(hasRow(mermaid(['flowchart LR', '  a -- "two<br/>lines" --> b']), 'two lines')).toBe(true)
  })

  test('an inline edge label may hold lone hyphens and operators', () => {
    expect(hasRow(mermaid(['flowchart LR', '  a -- re-try x = 1 --> b']), 're-try x = 1')).toBe(true)
  })

  test('a node set up with shape attributes draws its label', () => {
    expect(hasRow(mermaid(['flowchart LR', '  a@{ shape: procs, label: "Work queue" } --> b']), 'Work queue')).toBe(true)
  })

  test('a line break in a node label is kept', () => {
    const lines = mermaid(['flowchart TD', '  a["first<br/>second"]']).map(lineText)

    expect(lines.findIndex(line => line.includes('second'))).toBe(lines.findIndex(line => line.includes('first')) + 1)
  })

  test('a long sequence message wraps instead of pushing the lifelines apart', () => {
    const message = Array.from({ length: 30 }, () => 'word').join(' ')
    const lines = mermaid(['sequenceDiagram', `  A->>B: ${message}`], 200)

    expect(widestRow(lines)).toBeLessThan(60)
    expect(lines.map(lineText).join(' ').match(/word/g)?.length).toBe(30)
  })

  test('a semicolon inside sequence text stays part of it', () => {
    expect(hasRow(mermaid(['sequenceDiagram', '  A->>B: first; second']), 'first; second')).toBe(true)
  })

  test('a diagram colours its lines apart from its boxes and text', () => {
    const spans = mermaid(['flowchart LR', '  a[One] --> b[Two]']).flatMap(line => line.spans)
    const colorOf = (text: string) => spans.find(span => span.t.includes(text))?.fg

    expect(colorOf('▶')).toBe(C.accent)
    expect(colorOf('One')).toBe(C.fg)
    expect(colorOf('┌')).toBe(C.faint)
  })

  test('a diagram that drops a statement says so beneath the drawing', () => {
    const lines = mermaid(['flowchart LR', '  a --> b', '  c -->']).map(lineText)

    expect(lines.some(line => /│ a ├─+▶│ b │/.test(line))).toBe(true)
    expect(lines.at(-1)).toContain('dropped')
  })

  test('each rendered row knows the source lines it came from', () => {
    const lines = renderMarkdown(['# Title', '', 'First paragraph.', '', '| a | b |', '|---|---|', '| 1 | 2 |', '', '```go', 'x := 1', '```'].join('\n'), 60)
    const sourceOf = (text: string) => lines.filter(line => lineText(line).includes(text)).map(line => [line.from, line.to])

    expect(sourceOf('Title')).toEqual([[0, 0]])
    expect(sourceOf('First paragraph.')).toEqual([[2, 2]])
    expect(sourceOf('│ 1 ')).toEqual([[6, 6]])
    expect(sourceOf('x := 1')).toEqual([[9, 9]])
  })

  test('a mermaid diagram type the renderer does not draw shows as its source', () => {
    const lines = renderMarkdown('```mermaid\npie title Pets\n  "Dogs": 3\n```', 80).map(lineText)

    expect(lines.map(line => line.trim())).toEqual(['pie title Pets', '"Dogs": 3'])
  })
})

describe('grouping', () => {
  const PATHS = ['api/types.go', 'api/handler.go', 'api/handler_test.go', 'README.md']

  test('every file lands in exactly one group, in the order the model gave', () => {
    const reply = 'Here you go: {"groups":[{"title":"Handler","why":"The endpoint and its test.","files":[2,3,2]},{"title":"Types","why":"Shapes.","files":[1,3,9]}]}'
    const groups = parseGroups(reply, PATHS)

    expect(groups?.map(group => [group.title, group.paths])).toEqual([
      ['Handler', ['api/handler.go', 'api/handler_test.go']],
      ['Types', ['api/types.go']],
      ['Other changes', ['README.md']],
    ])
  })

  test('a reply with no usable group is no grouping', () => {
    expect(parseGroups('I could not do that.', PATHS)).toBeNull()
    expect(parseGroups('{"groups":[{"title":"Empty","why":"None.","files":[42]}]}', PATHS)).toBeNull()
  })

  test('the diff splits into each listed file\'s hunks, renames under the new path and lockfiles left out', () => {
    const diff = [
      'diff --git a/old/a.go b/new/a.go',
      'similarity index 90%',
      'rename from old/a.go',
      'rename to new/a.go',
      '@@ -1 +1 @@',
      '-package old',
      '+package new',
      'diff --git a/gone.go b/gone.go',
      'deleted file mode 100644',
      '@@ -1 +0,0 @@',
      '-package gone',
      'diff --git a/go.sum b/go.sum',
      '@@ -1 +1 @@',
      '-x v1',
      '+x v2',
      '',
    ].join('\n')
    const bodies = splitDiff(diff, ['new/a.go', 'gone.go', 'go.sum'])

    expect(bodies.get('new/a.go')).toBe('@@ -1 +1 @@\n-package old\n+package new\n')
    expect(bodies.get('gone.go')).toBe('@@ -1 +0,0 @@\n-package gone\n')
    expect(bodies.has('go.sum')).toBe(false)
  })

  test('a diff past the budget keeps small files whole and cuts the large one', () => {
    const listing: Listing = { mode: 'branch', label: '', branch: '', target: '', from: 'a', to: 'b', oldPaths: {}, files: [{ path: 'big.ts', status: 'A', version: '', added: 9000, removed: 0, isBinary: false }, { path: 'small.ts', status: 'M', version: '', added: 1, removed: 1, isBinary: false }] }
    const big = Array.from({ length: 9000 }, (_, i) => `+const generated${i} = "${'x'.repeat(30)}"`).join('\n')
    const diff = `diff --git a/big.ts b/big.ts\n@@ -0,0 +1,9000 @@\n${big}\ndiff --git a/small.ts b/small.ts\n@@ -1 +1 @@\n-one\n+two\n`
    const prompt = groupingPrompt(listing, diff, false)

    expect(prompt.length).toBeLessThan(155_000)
    expect(prompt).toContain('### 2 small.ts\n@@ -1 +1 @@\n-one\n+two')
    expect(prompt).toContain('… (cut)')
  })
})
