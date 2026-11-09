import { type KeyEvent, Line, type PointerEvent, type Style, type Surface, type WheelAxis } from './surface'
import type { Actions, Change, FileEntry, FileGroup, FileStatus, Layout, Mode, PickKind, Row, RowKind, Segment, Side, Toggle, ViewerComment, ViewerFile, ViewerProps } from './types'
import { languageFor, type ThemedToken, tokenize } from './viewer/highlight'
import { type MdLine, renderMarkdown, type Span, spanWidth } from './viewer/markdown'
import { buildItems, type Item, itemRow, type Note, withFiles, withGroups, wrapText } from './viewer/model'
import { C } from './viewer/palette'
import { editText } from './viewer/text'
import { buildGroupedTree, buildTree, matcher, type TreeRow } from './viewer/tree'
import { type Ranges, wordRanges } from './viewer/words'

const MODES: [Mode, string, string][] = [
  ['worktree', 'Worktree', 'uncommitted changes'],
  ['branch', 'Branch', 'everything since the base'],
  ['commit', 'Commit', "one commit's changes"],
  ['turn', 'Turn', 'what one Claude turn changed'],
  ['review', 'Since review', 'what changed after you last sent comments'],
]

/** `typed` offers the filter text itself as an entry, for refs git resolves that the list does not hold. */
const PICKERS: Record<PickerKind, { title: string; placeholder: string; fallback: string; typed?: string }> = {
  mode: { title: 'Compare', placeholder: 'Filter…', fallback: '' },
  view: { title: 'View', placeholder: '', fallback: '' },
  files: { title: 'Files', placeholder: 'Filter files…', fallback: '' },
  branch: { title: 'Compare against', placeholder: 'Filter branches, or type any ref…', fallback: 'Stack parent or default branch', typed: 'Compare against' },
  commit: { title: 'Commit', placeholder: 'Filter commits, or type a hash…', fallback: 'Latest commit (HEAD)', typed: 'Show commit' },
  turn: { title: 'Turn', placeholder: 'Filter turns…', fallback: 'Last turn' },
}

function pickKind(mode: Mode): PickKind | undefined {
  return mode === 'worktree' || mode === 'review' ? undefined : mode
}

/** Whether a picker lists git's entries, which load only while it is open. */
function isTargetPicker(kind: PickerKind): kind is PickKind {
  return kind !== 'mode' && kind !== 'view' && kind !== 'files'
}

const MAX_TARGET = 36

const TAB = 4
const EXPAND_STEP = 20
const WHEEL_ROWS = 3
const HSCROLL_STEP = 8
/** Columns per sideways wheel notch; trackpads send many small notches, so this stays small. */
const HSCROLL_WHEEL = 2
const MIN_TREE = 16
const MIN_DIFF = 30
/** Narrower than this, as on a phone, the tree and two code columns leave too little room to read. */
const COMPACT_BELOW = 64
/** Wrapping is what spares a phone sideways swipes, which its terminal app keeps for moving between panes. */
const COMPACT_OPTIONS = { layout: 'unified', showTree: false, wrap: true } as const
const COMPOSER_NOTE_ID = -1

// --- local state ---------------------------------------------------------------

type Selection = { side: Side; anchor: number; start: number; end: number; isDragging: boolean }
/** `quote` is the text highlighted in the markdown preview the comment is about; `editing` the id of the comment it rewrites. */
type Composer = { side: Side; startRow: number; endRow: number; text: string; cursor: number; quote?: string; editing?: number }
/** A place in the preview's rendered text: a row and a column of its content, before any sideways scroll. */
type MdPoint = { line: number; col: number }
type MdSelection = { anchor: MdPoint; head: MdPoint; isDragging: boolean }
type PreviewItem = { k: 'md'; line: number } | { k: 'note'; id: number; part: number }
type Focus = 'diff' | 'composer' | 'search' | 'picker'
type PickerKind = 'mode' | 'view' | 'files' | PickKind
type Picker = { kind: PickerKind; filter: string; index: number; scroll: number }

type Action =
  | { a: 'line'; side: Side; row: number }
  | { a: 'gap'; from: number; to: number }
  | { a: 'run'; run: (actions: Actions) => void }
  | { a: 'edit'; id: number }
  | { a: 'viewed'; path: string }
  | { a: 'delete'; id: number }
  | { a: 'composer-focus' }
  | { a: 'composer-cancel' }
  | { a: 'composer-submit' }
  | { a: 'search-focus' }
  | { a: 'dir'; path: string }
  | { a: 'file'; path: string }
  | { a: 'open'; path: string }
  | { a: 'preview' }
  | { a: 'step-file'; by: number }
  | { a: 'md'; line: number }
  | { a: 'hscroll'; by: number }
  | { a: 'hbar' }
  | { a: 'divider' }
  | { a: 'picker'; kind: PickerKind }
  | { a: 'choose'; id: string }

type Zone = { y: number; x0: number; x1: number; act: Action }

type Drag =
  | { kind: 'select' }
  | { kind: 'hbar'; x: number; hscroll: number; perCell: number }
  | { kind: 'tree' }

type HighlightPart = { newSide: ThemedToken[][] | undefined; oldSide: ThemedToken[][] | undefined }

/** Tokens for the file's rows, one part per file in the all-files view, so each file colours in its own language. */
type Highlight = { parts: HighlightPart[]; partOf: Int32Array; newLine: Int32Array; oldLine: Int32Array }

type Piece = { start: number; text: string }

type State = {
  surface: Surface
  actions: Actions
  props: ViewerProps
  fileKey: string
  scroll: number
  hscroll: number
  scrollToChange: boolean
  /** The file at the top of the all-files view and how many rows into it, for `view`, the mode and target it shows. */
  reading: { view: string; path: string; offset: number } | null
  /** Where to put the reader once a rebuilt all-files view is laid out. */
  resume: { path: string; offset: number } | null
  revealed: Uint8Array
  revealedVersion: number
  selection: Selection | null
  composer: Composer | null
  /** What the composer's position last depended on, so it is scrolled to only when that changes. */
  composerSeen: string
  draft: string
  focus: Focus
  search: string
  picker: Picker | null
  treeWidth: number | undefined
  treeScroll: number
  closedDirs: Set<string>
  highlight: Highlight | null
  words: Map<number, Ranges | null>
  items: { sig: string; list: Item[]; changeStarts: number[]; fileStarts: number[] } | null
  wraps: Map<number, Piece[]>
  lineDigits: number
  topSeg: number
  zones: Zone[]
  previewScroll: number
  /** `rowOf` maps a source line of the markdown to its row in the file. */
  preview: { sig: string; lines: MdLine[]; rowOf: number[] } | null
  previewSel: MdSelection | null
  drag: Drag | null
  maxCode: number
  hbar: { x: number; track: number; thumb: number; max: number } | null
  /** The grouping spinner's next frame; only one waits at a time, so redraws from elsewhere start no extra timers. */
  spinnerTick: ReturnType<typeof setTimeout> | null
  geometry: { width: number; height: number; diffWidth: number; treeWidth: number; bodyTop: number; bodyRows: number }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0a-\x1f\x7f]/g

function displayWidth(text: string): number {
  let column = 0
  for (const char of text) column += char === '\t' ? TAB - (column % TAB) : 1
  return column
}

/** The tree's width, leaving the diff its minimum. */
function clampTree(width: number, total: number): number {
  return Math.max(MIN_TREE, Math.min(width, total - MIN_DIFF - 1))
}

function pad(value: number, width: number): string {
  return (value > 0 ? String(value) : '').padStart(width)
}

// --- the module ------------------------------------------------------------------

export type Viewer = {
  /** The whole screen for these props, one line per row. */
  draw(props: ViewerProps): Line[]
  key(event: KeyEvent): void
  pointer(event: PointerEvent): void
  /** Scrolls whatever sits under `column` by `by` wheel notches, sideways for a horizontal swipe. */
  wheel(by: number, column: number, axis: WheelAxis): void
}

export function createViewer(props: ViewerProps, surface: Surface, actions: Actions): Viewer {
  const s = createState(props, surface, actions)

  return {
    draw: next => draw(s, next),
    key: event => onKey(s, event),
    pointer: event => onPointer(s, event),
    wheel: (by, column, axis) => {
      if (axis === 'horizontal') s.hscroll = Math.max(0, s.hscroll + by * HSCROLL_WHEEL)
      else applyWheel(s, by, column)
      redraw(s)
    },
  }
}

function isCompact(s: State): boolean {
  return s.surface.columns < COMPACT_BELOW
}

function draw(s: State, props: ViewerProps): Line[] {
  // Applied here rather than saved, so a pane that is narrow for a while leaves the saved options as they were.
  s.props = isCompact(s) ? { ...props, options: { ...props.options, ...COMPACT_OPTIONS } } : props
  syncFile(s)

  const width = s.surface.columns
  const height = s.surface.rows
  if (width < 30 || height < 5) {
    const line = new Line(width)
    line.add('Diff review needs a larger pane.', { fg: C.dim })
    return [line]
  }

  const { showTree } = s.props.options
  const treeWidth = showTree ? clampTree(s.treeWidth ?? Math.max(24, Math.min(44, Math.floor(width * 0.28))), width) : 0
  const diffWidth = width - treeWidth - (showTree ? 1 : 0)
  s.zones = []

  const bar = drawBar(s, width)
  const bodyTop = bar.isMerged ? 1 : 2
  const bodyRows = height - bodyTop
  s.geometry = { width, height, diffWidth, treeWidth, bodyTop, bodyRows }

  const body =
    s.picker !== null
      ? drawPicker(s, s.picker, diffWidth, bodyRows)
      : isPreviewing(s)
        ? drawPreview(s, diffWidth, bodyRows)
        : drawBody(s, diffWidth, bodyRows)
  const left = bar.isMerged ? body : [drawFileHeader(s, diffWidth), ...body]
  const screen = [bar.line]

  if (!showTree) return [...screen, ...left]

  const tree = drawTree(s, treeWidth, height - 1, diffWidth + 1)
  const dividerColor = s.drag?.kind === 'tree' ? C.accent : C.border
  for (let i = 0; i < height - 1; i++) {
    zone(s, i + 1, [diffWidth, diffWidth + 1], { a: 'divider' })
    const row = new Line(width)
    const diff = left[i]
    if (diff !== undefined) row.append(diff)
    row.fill({}, diffWidth)
    row.add('│', { fg: dividerColor })
    const branch = tree[i]
    if (branch !== undefined) row.append(branch)
    screen.push(row)
  }

  return screen
}

function createState(props: ViewerProps, surface: Surface, actions: Actions): State {
  const s: State = {
    surface,
    actions,
    props,
    fileKey: '',
    scroll: 0,
    hscroll: 0,
    scrollToChange: true,
    reading: null,
    resume: null,
    revealed: new Uint8Array(0),
    revealedVersion: 0,
    selection: null,
    composer: null,
    composerSeen: '',
    draft: '',
    focus: 'diff',
    search: '',
    picker: null,
    treeWidth: props.options.treeWidth,
    treeScroll: 0,
    closedDirs: new Set(),
    highlight: null,
    words: new Map(),
    items: null,
    wraps: new Map(),
    lineDigits: 3,
    topSeg: 0,
    zones: [],
    previewScroll: 0,
    preview: null,
    previewSel: null,
    drag: null,
    maxCode: 0,
    hbar: null,
    spinnerTick: null,
    geometry: { width: 0, height: 0, diffWidth: 0, treeWidth: 0, bodyTop: 2, bodyRows: 0 },
  }

  return s
}

function redraw(s: State): void {
  s.surface.redraw()
}


// --- props sync --------------------------------------------------------------------

function syncFile(s: State): void {
  const file = s.props.file
  const key = file?.key ?? ''

  if (key !== s.fileKey) {
    // The same all-files view rebuilt, after a turn, a fold or new groups, keeps the reader where they were.
    const reading = s.reading
    const segments = file?.segments
    const isSameView = segments !== undefined && reading !== null && reading.view === viewId(s)
    s.resume = isSameView ? reading : null
    s.fileKey = key
    s.scroll = 0
    s.hscroll = 0
    s.scrollToChange = !isSameView
    s.revealed = new Uint8Array(file?.rows.length ?? 0)
    s.revealedVersion += 1
    s.selection = null
    s.composer = null
    s.previewSel = null
    s.words = new Map()
    s.previewScroll = 0
    s.topSeg = isSameView ? Math.max(0, segments.findIndex(segment => segment.path === reading.path)) : 0
    // The all-files view carries only the rows it shows, so none of them fold.
    if (file?.segments !== undefined) s.revealed.fill(1)
    revealCurrentInTree(s)

    s.highlight = file === null ? null : buildHighlight(file)
    s.maxCode = file?.rows.reduce((widest, row) => Math.max(widest, displayWidth(row.text)), 0) ?? 0
    const lastLine = file?.rows.reduce((widest, row) => Math.max(widest, row.old, row.new), 0) ?? 0
    s.lineDigits = Math.max(3, String(lastLine).length)
  }
}

function viewId(s: State): string {
  return `${s.props.mode}\0${s.props.target}`
}

function buildHighlight(file: ViewerFile): Highlight {
  const { rows } = file
  const spans = file.segments ?? [{ path: file.path, start: 0, end: rows.length }]
  const partOf = new Int32Array(rows.length).fill(-1)
  const newLine = new Int32Array(rows.length).fill(-1)
  const oldLine = new Int32Array(rows.length).fill(-1)

  const parts = spans.map((span, part) => {
    const newLines: string[] = []
    const oldLines: string[] = []
    for (let i = span.start; i < span.end; i++) {
      const { kind, text: raw } = rows[i] as Row
      const text = raw.replace(CONTROL, '')
      partOf[i] = part
      if (kind !== 'removed') newLine[i] = newLines.push(text) - 1
      if (kind !== 'added') oldLine[i] = oldLines.push(text) - 1
    }

    const language = languageFor(span.path)
    return { newSide: tokenize(newLines, language), oldSide: tokenize(oldLines, language) }
  })

  return { parts, partOf, newLine, oldLine }
}

function applyWheel(s: State, notches: number, column: number): void {
  const { diffWidth } = s.geometry
  const isOverTree = s.props.options.showTree && column > diffWidth
  const by = notches * WHEEL_ROWS

  if (isOverTree) s.treeScroll = Math.max(0, s.treeScroll + by)
  else if (s.picker !== null) s.picker.index = Math.max(0, s.picker.index + by)
  else if (isPreviewing(s)) s.previewScroll = Math.max(0, s.previewScroll + by)
  else s.scroll = Math.max(0, s.scroll + by)
}

// --- rows and tokens -----------------------------------------------------------------

function rowAt(s: State, index: number): Row | undefined {
  return s.props.file?.rows[index]
}

function tokensFor(s: State, index: number, side: Side): ThemedToken[] | undefined {
  const hl = s.highlight
  if (hl === null) return undefined
  const row = rowAt(s, index)
  const useOld = side === 'old' && row?.kind === 'removed'
  const line = (useOld ? hl.oldLine : hl.newLine)[index] ?? -1
  const part = hl.parts[hl.partOf[index] ?? -1]
  if (line < 0 || part === undefined) return undefined

  return (useOld ? part.oldSide : part.newSide)?.[line]
}

function changeOf(s: State, index: number): Change | undefined {
  const changes = s.props.file?.changes ?? []
  let low = 0
  let high = changes.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const change = changes[mid] as Change
    if (index < change.start) high = mid - 1
    else if (index >= change.end) low = mid + 1
    else return change
  }

  return undefined
}

/** The changed ranges of a removed or added row against the row it pairs with. */
function wordsFor(s: State, index: number): Ranges | null {
  const cached = s.words.get(index)
  if (cached !== undefined) return cached

  const change = changeOf(s, index)
  const row = rowAt(s, index)
  if (change === undefined || row === undefined || row.kind === 'context') return null

  const { start, end, removed } = change
  const added = end - start - removed
  const isRemoved = row.kind === 'removed'
  const offset = isRemoved ? index - start : index - start - removed
  const hasPartner = isRemoved ? offset < added : offset < removed
  const partnerIndex = isRemoved ? start + removed + offset : start + offset
  const partner = hasPartner ? rowAt(s, partnerIndex) : undefined

  if (partner === undefined) {
    s.words.set(index, null)
    return null
  }

  const [before, after] = isRemoved ? [row.text, partner.text] : [partner.text, row.text]
  const ranges = wordRanges(before, after)
  s.words.set(isRemoved ? index : partnerIndex, ranges?.old ?? null)
  s.words.set(isRemoved ? partnerIndex : index, ranges?.new ?? null)

  return s.words.get(index) ?? null
}

/** Draws code into `line`: syntax colours, word-change backgrounds, visible changed whitespace, tabs expanded. */
function drawCode(line: Line, text: string, tokens: ThemedToken[] | undefined, changed: Ranges | null, lineBg: string | undefined, wordBg: string, hscroll: number): void {
  const pieces = tokens ?? [{ content: text, offset: 0 } as ThemedToken]
  let column = 0
  let skipped = 0

  const emit = (chunk: string, style: Style) => {
    let out = chunk
    if (skipped < hscroll) {
      const drop = Math.min(out.length, hscroll - skipped)
      skipped += drop
      out = out.slice(drop)
    }
    if (out.length > 0) line.add(out, style)
  }

  let offset = 0
  for (const token of pieces) {
    const content = token.content
    const fg = token.color ?? C.fg
    const italic = token.fontStyle !== undefined && (token.fontStyle & 1) === 1
    const bold = token.fontStyle !== undefined && (token.fontStyle & 2) === 2

    let at = 0
    while (at < content.length && line.room > 0) {
      const absolute = offset + at
      const range = changed?.find(([start, end]) => absolute < end && absolute + 1 > start)
      const nextBoundary = changed?.map(([start, end]) => (absolute < start ? start : absolute < end ? end : Infinity)).reduce((a, b) => Math.min(a, b), Infinity) ?? Infinity
      const stop = Math.min(content.length, nextBoundary - offset)
      const piece = content.slice(at, Math.max(at + 1, stop)).replace(CONTROL, '')
      const isChanged = range !== undefined

      let rendered = ''
      for (const char of piece) {
        if (char === '\t') {
          const spaces = TAB - (column % TAB)
          rendered += isChanged ? '→'.padEnd(spaces) : ' '.repeat(spaces)
          column += spaces
        } else {
          rendered += isChanged && char === ' ' ? '·' : char
          column += 1
        }
      }

      const isWhitespace = piece.trim() === ''
      emit(rendered, { fg: isChanged && isWhitespace ? C.dim : fg, bg: isChanged ? wordBg : lineBg, italic, bold })
      at += Math.max(1, stop - at)
    }
    offset += content.length
  }
}

// --- items -----------------------------------------------------------------------------

/** Comment boxes sit past the line numbers in the diff and at the edge in the preview. */
function noteIndent(s: State, row: number): number {
  return isPreviewing(s) || isCompact(s) ? 0 : gutterWidth(s, shapeAt(s, row))
}

function noteWidth(s: State, row: number): number {
  return Math.max(20, s.geometry.diffWidth - noteIndent(s, row) - 2)
}

function noteInner(s: State, row: number): number {
  return noteWidth(s, row) - 4
}

function commentLines(s: State, comment: ViewerComment): { start: number; text: string }[] {
  return wrapText(comment.text, noteInner(s, comment.endRow))
}

function composerLines(s: State): { start: number; text: string }[] {
  const composer = s.composer
  return composer === null ? [] : wrapText(composer.text, noteInner(s, composer.endRow) - 1)
}

/** The comments drawn as boxes: all but the one the composer is rewriting, which it stands in for. */
function shownComments(s: State): ViewerComment[] {
  const editing = s.composer?.editing
  return s.props.comments.filter(c => c.id !== editing)
}

function itemsFor(s: State): { list: Item[]; changeStarts: number[] } {
  const file = s.props.file
  if (file === null) return { list: [], changeStarts: [] }

  const composer = s.composer
  const comments = shownComments(s)
  const isWrapped = s.props.options.wrap
  const sig = [
    file.key,
    isWrapped,
    s.props.options.layout,
    s.props.options.lineNumbers,
    s.revealedVersion,
    s.geometry.diffWidth,
    comments.map(c => `${c.id}:${c.endRow}:${c.text.length}`).join(','),
    composer === null ? '' : `${composer.endRow}:${composer.side}:${composerLines(s).length}`,
  ].join('|')
  if (s.items?.sig === sig) return s.items

  const notes: Note[] = comments.map(c => ({ id: c.id, side: c.side, endRow: c.endRow, height: commentLines(s, c).length + 3 }))
  if (composer !== null) {
    notes.push({ id: COMPOSER_NOTE_ID, side: composer.side, endRow: composer.endRow, height: Math.max(1, composerLines(s).length) + 3 })
  }

  const built = buildItems({ total: file.rows.length, changes: file.changes, revealed: s.revealed, layoutAt: row => (shapeAt(s, row) === 'split' ? 'split' : 'unified'), notes })
  const groups = readyGroups(s)
  const segments = file.segments
  const withHeaders = segments === undefined ? built : withFiles(built, segments, index => rowAt(s, index))
  const base = segments === undefined || groups === null ? withHeaders : withGroups(withHeaders, segments, path => groups.findIndex(group => group.paths.includes(path)))

  // A wrapped row takes one item per piece; `at` maps each base item to its first.
  s.wraps = new Map()
  const list: Item[] = []
  const at: number[] = []
  for (const item of base) {
    at.push(list.length)
    const parts = isWrapped ? partsOf(s, item) : 1
    for (let part = 0; part < parts; part++) {
      if (item.k === 'line') list.push({ ...item, part })
      else if (item.k === 'pair') list.push({ ...item, part })
      else list.push(item)
    }
  }

  const starts = new Set(file.changes.map(change => change.start))
  const changeStarts = base.flatMap((item, i) => {
    const row = itemRow(item)
    const previous = base[i - 1]
    const isFirstOfPair = item.k !== 'pair' || previous?.k !== 'pair' || !starts.has(row) || previous.left !== row - 1
    return starts.has(row) && isFirstOfPair ? [at[i] as number] : []
  })
  // A group's first file starts at the group's title, so stepping to it shows what the group is.
  const fileStarts = list.flatMap((item, i) => (item.k !== 'file' ? [] : [list[i - 2]?.k === 'group' ? i - 2 : i]))

  s.items = { sig, list, changeStarts, fileStarts }
  return s.items
}

/** A row's text cut at word boundaries to the code column's width, tabs expanded as drawn. */
function piecesFor(s: State, index: number): Piece[] {
  const cached = s.wraps.get(index)
  if (cached !== undefined) return cached

  const row = rowAt(s, index)
  if (row === undefined) return [{ start: 0, text: '' }]

  let expanded = ''
  for (const char of row.text.replace(CONTROL, '')) expanded += char === '\t' ? ' '.repeat(TAB - (expanded.length % TAB)) : char
  const pieces = wrapText(expanded, codeWidth(s, s.geometry.diffWidth, shapeAt(s, index)))
  s.wraps.set(index, pieces)

  return pieces
}

function partsOf(s: State, item: Item): number {
  if (item.k === 'line') return piecesFor(s, item.row).length
  if (item.k !== 'pair') return 1
  const left = item.left >= 0 ? piecesFor(s, item.left).length : 1
  const right = item.right >= 0 ? piecesFor(s, item.right).length : 1

  return Math.max(left, right)
}

function segmentsOf(s: State): Segment[] | undefined {
  return s.props.file?.segments
}

function segmentAt(s: State, row: number): number {
  return Math.max(0, segmentsOf(s)?.findIndex(seg => row >= seg.start && row < seg.end) ?? 0)
}

/** The file the person is reading: the one at the top of the all-files view, or the one file shown. */
function currentPath(s: State): string | undefined {
  const segments = segmentsOf(s)
  return segments === undefined ? s.props.file?.path : segments[s.topSeg]?.path
}

function updateTopSeg(s: State, list: Item[]): void {
  if (segmentsOf(s) === undefined) return

  let seg = 0
  for (let i = Math.min(s.scroll, list.length - 1); i >= 0; i--) {
    const item = list[i] as Item
    if (item.k === 'file' || item.k === 'fold' || item.k === 'group') {
      seg = item.seg
      break
    }
    const row = itemRow(item)
    if (row >= 0) {
      seg = segmentAt(s, row)
      break
    }
  }

  const path = segmentsOf(s)?.[seg]?.path
  if (path !== undefined) s.reading = { view: viewId(s), path, offset: s.scroll - (s.items?.fileStarts[seg] ?? 0) }
  setTopSeg(s, seg)
}

/** The header is drawn before the body scrolls, so a jump to a file sets the file it names right away. */
function setTopSeg(s: State, seg: number): void {
  if (seg === s.topSeg) return
  s.topSeg = seg
  revealCurrentInTree(s)
}

function resumeReading(s: State, at: { path: string; offset: number }, total: number): void {
  s.resume = null
  const starts = s.items?.fileStarts ?? []
  const seg = segmentsOf(s)?.findIndex(segment => segment.path === at.path) ?? -1
  const start = starts[seg]
  if (start === undefined) return

  const length = (starts[seg + 1] ?? total) - start
  s.scroll = start + Math.max(0, Math.min(at.offset, length - 1))
}

/** How a row draws; a new or deleted file has one side, so it draws unified with one line number. */
type Shape = Layout | 'one-sided'

function shapeAt(s: State, row: number): Shape {
  const segments = segmentsOf(s)
  const status = segments === undefined ? s.props.file?.status : segments[segmentAt(s, row)]?.status
  return status === 'A' || status === 'D' ? 'one-sided' : s.props.options.layout
}

/** The line numbers before a row's +/- marker, or nothing while they are hidden. */
function gutterText(s: State, numbers: number[]): string {
  return s.props.options.lineNumbers ? numbers.map(no => `${pad(no, s.lineDigits)} `).join('') : ''
}

/** Cells before a row's code: the numbers' columns and the marker. */
function gutterWidth(s: State, shape: Shape): number {
  const columns = shape === 'unified' ? 2 : 1
  return (s.props.options.lineNumbers ? columns * (s.lineDigits + 1) : 0) + 1
}

// --- drawing: bars ---------------------------------------------------------------------

function zone(s: State, y: number, range: [number, number], act: Action, xOffset = 0): void {
  if (range[1] > range[0]) s.zones.push({ y, x0: range[0] + xOffset, x1: range[1] + xOffset, act })
}

type Button = [string, boolean, Action]

/**
 * An entry of the View menu; `key` presses it from the menu or the diff, `button` is its label on the
 * bar, `option` the setting it toggles, and `isOn` is absent for an action.
 */
type ViewItem = { key: string; label: string; button: string; isOn?: boolean; option?: Toggle; act: Action }

function viewItems(s: State): ViewItem[] {
  const { options, mode, grouping } = s.props
  const isPending = grouping?.status === 'pending'
  const file = headerFile(s)
  const toggle = (what: Toggle): Action => ({ a: 'run', run: actions => actions.toggle(what) })

  const items: ViewItem[] = [
    { key: 's', label: 'Side by side', button: 'Split', isOn: options.layout === 'split', option: 'layout', act: toggle('layout') },
    { key: 'o', label: isPending ? 'Grouping…' : 'Group by change', button: isPending ? `${spinner(s)} Grouping` : 'Grouped', isOn: options.groupedModes.includes(mode), option: 'grouped', act: toggle('grouped') },
    { key: 't', label: 'File tree', button: 'Tree', isOn: options.showTree, option: 'showTree', act: toggle('showTree') },
    { key: '#', label: 'Line numbers', button: '#', isOn: options.lineNumbers, option: 'lineNumbers', act: toggle('lineNumbers') },
    { key: 'w', label: 'Wrap long lines', button: 'Wrap', isOn: options.wrap, option: 'wrap', act: toggle('wrap') },
  ]
  if (file !== null && languageFor(file.path) === 'markdown') items.push({ key: 'v', label: 'Markdown preview', button: 'Preview', isOn: isPreviewing(s), act: { a: 'preview' } })
  items.push({ key: 'r', label: 'Refresh', button: '↻', act: { a: 'run', run: actions => actions.refresh() } })

  // A toggle of an option compact fixes would change nothing on screen, and only rewrite the saved option.
  return isCompact(s) ? items.filter(({ option }) => option === undefined || !Object.hasOwn(COMPACT_OPTIONS, option)) : items
}

const VIEW_LABEL = ' View ▾ '

function viewButtons(s: State): Button[] {
  return viewItems(s).map(item => [` ${item.button} `, item.isOn === true, item.act])
}

/** The cells the View controls take: its items as `buttons`, or the View select when null. */
function controlsWidth(buttons: Button[] | null): number {
  return buttons === null ? VIEW_LABEL.length : buttonsWidth(buttons)
}

/** The View items as buttons, or the View menu's select when `buttons` is null, flush right. */
function addViewControls(s: State, line: Line, buttons: Button[] | null): void {
  if (buttons !== null) return addButtons(s, line, 0, buttons)
  line.fill({}, line.width - VIEW_LABEL.length)
  zone(s, 0, line.add(VIEW_LABEL, selectStyle(s, 'view')), { a: 'picker', kind: 'view' })
}

function buttonsWidth(buttons: Button[]): number {
  return buttons.reduce((sum, [label]) => sum + label.length + 1, 0)
}

/** Draws buttons flush right, each after a one-cell space. */
function addButtons(s: State, line: Line, y: number, buttons: Button[], bg?: string): void {
  line.fill({ bg }, line.width - buttonsWidth(buttons))
  for (const [label, isOn, act] of buttons) {
    line.add(' ', { bg })
    zone(s, y, line.add(label, isOn ? { fg: C.fg, bg: C.button, bold: true } : { fg: C.dim, bg: C.bar }), act)
  }
}

function selectStyle(s: State, kind: PickerKind) {
  return s.picker?.kind === kind ? { fg: '#0d1117', bg: C.accent, bold: true } : { fg: C.accent, bg: C.button }
}

function addModeSelect(s: State, line: Line): void {
  const label = MODES.find(([mode]) => mode === s.props.mode)?.[1] ?? ''
  zone(s, 0, line.add(` ${label} ▾ `, { ...selectStyle(s, 'mode'), bold: true }), { a: 'picker', kind: 'mode' })
}

const MIN_TARGET = 6

function targetLabel(s: State, kind: PickKind, max: number): string {
  const name = s.props.target === '' ? PICKERS[kind].fallback : s.props.target
  return ` ${name.length > max ? `${name.slice(0, max - 1)}…` : name} ▾ `
}

/**
 * The select for what the mode compares within: the base, the commit or the turn, its name cut to fit
 * `room`. Returns false when the mode has one and it didn't fit.
 */
function addTarget(s: State, line: Line, room = Infinity): boolean {
  const kind = pickKind(s.props.mode)
  if (kind === undefined) return true
  const max = Math.min(MAX_TARGET, room - 4)
  if (max < MIN_TARGET) return false
  zone(s, 0, line.add(targetLabel(s, kind, max), selectStyle(s, kind)), { a: 'picker', kind })
  return true
}

/** Lines added and removed across every listed file. */
function addTotals(s: State, line: Line): void {
  const added = s.props.files.reduce((sum, file) => sum + file.added, 0)
  const removed = s.props.files.reduce((sum, file) => sum + file.removed, 0)
  line.add(`  +${added}`, { fg: C.green })
  line.add(` -${removed}`, { fg: C.red })
}

/**
 * The top row: the bar and the file's header as one row when the path keeps MIN_PATH cells, else the bar
 * alone with the header on the next row. The View items show as buttons wherever they fit, which wins over
 * sharing the row; only a pane too narrow for them, or a compact one, gets the View select instead.
 */
function drawBar(s: State, width: number): { line: Line; isMerged: boolean } {
  for (const controls of isCompact(s) ? [null] : [viewButtons(s), null]) {
    const merged = drawMergedBar(s, width, controls)
    if (merged !== null) return { line: merged, isMerged: true }
    const top = drawTopBar(s, width, controls)
    if (top !== null) return { line: top, isMerged: false }
  }

  return { line: new Line(width), isMerged: false }
}

function clip(text: string, room: number): string {
  if (text.length <= room) return text
  return room <= 3 ? '' : `${text.slice(0, room - 1)}…`
}

function addFilePath(line: Line, path: string, status: FileStatus, bg: string | undefined): void {
  const slash = path.lastIndexOf('/')
  const statusColor = { A: C.green, D: C.red, R: C.yellow, M: C.dim }[status]

  line.add(` ${status} `, { fg: statusColor, bg, bold: true })
  line.add(path.slice(0, slash + 1), { fg: C.dim, bg })
  line.add(path.slice(slash + 1), { fg: C.fg, bg, bold: true })
}

/** A path cut from the left to fit `room`, since the file's name matters most. */
function clipPath(path: string, room: number): string {
  const fit = Math.max(2, room)
  return path.length > fit ? `…${path.slice(path.length - fit + 1)}` : path
}

/** The bar alone, or null when the mode's selects and totals leave no room for the View `buttons`. */
function drawTopBar(s: State, width: number, buttons: Button[] | null): Line | null {
  const { props } = s
  const zones = s.zones.length
  const line = new Line(width)
  const room = () => Math.max(0, width - controlsWidth(buttons) - line.used - 1)

  addModeSelect(s, line)
  line.add(props.mode === 'branch' ? ' vs ' : ' ', { fg: C.dim })
  const hasTarget = addTarget(s, line, room())
  addTotals(s, line)
  const isCramped = !hasTarget || line.used + 1 + controlsWidth(buttons) > width
  if (buttons !== null && isCramped) {
    s.zones.length = zones
    return null
  }

  if (props.mode === 'worktree') line.add(clip(`  ${props.label}`, room()), { fg: C.dim })
  if (props.isLoading) line.add(clip('  loading…', room()), { fg: C.dim })
  addViewControls(s, line, buttons)

  return line
}

const MIN_PATH = 20

/** The bar and the file's header as one row, or null when the path would get under MIN_PATH cells. */
function drawMergedBar(s: State, width: number, buttons: Button[] | null): Line | null {
  const zones = s.zones.length
  const line = new Line(width)

  addModeSelect(s, line)
  line.add(s.props.mode === 'branch' ? ' vs ' : ' ', { fg: C.dim })
  addTarget(s, line)
  addTotals(s, line)
  line.add('  ')
  const pathRoom = addFileHeader(s, line, 0, width - line.used - controlsWidth(buttons) - 1, undefined)
  if (pathRoom < MIN_PATH) {
    s.zones.length = zones
    return null
  }
  addViewControls(s, line, buttons)

  return line
}

function orderedFiles(s: State): FileEntry[] {
  return fileRows(s, '', new Set()).flatMap(row => (row.kind === 'file' ? [row.entry] : []))
}

/** What the header names: the one file shown, or the file at the top of the all-files view. */
function headerFile(s: State): Pick<FileEntry, 'path' | 'status'> | null {
  const segments = segmentsOf(s)
  if (segments === undefined) return s.props.file

  return segments[s.topSeg] ?? null
}

/** The previous and next buttons, the file's place in the list, its status and path, in `room` cells; returns the path's room. */
function addFileHeader(s: State, line: Line, y: number, room: number, bg: string | undefined): number {
  const end = line.used + room
  const file = headerFile(s)
  const files = orderedFiles(s)
  const index = file === null ? -1 : files.findIndex(entry => entry.path === file.path)

  if (s.props.view === 'opened') {
    zone(s, y, line.add(' ▴ All files ', { fg: C.accent, bg: C.button }), { a: 'run', run: actions => actions.showAll() })
    line.add(' ', { bg })
  }
  zone(s, y, line.add(' ◂ ', { fg: C.fg, bg: C.button }), { a: 'step-file', by: -1 })
  line.add(' ', { bg })
  zone(s, y, line.add(' ▸ ', { fg: C.fg, bg: C.button }), { a: 'step-file', by: 1 })
  const place = ` ${index + 1}/${files.length} `
  if (isCompact(s)) zone(s, y, line.add(`${place}▾ `, selectStyle(s, 'files')), { a: 'picker', kind: 'files' })
  else line.add(place, { fg: C.dim, bg })
  if (file === null) return Infinity

  const pathRoom = end - line.used - 3
  addFilePath(line, clipPath(file.path, pathRoom), file.status, bg)

  return pathRoom
}

function drawFileHeader(s: State, width: number): Line {
  const line = new Line(width)

  addFileHeader(s, line, 1, width, C.bar)
  line.fill({ bg: C.bar })

  return line
}

function addFilterBox(line: Line, text: string, placeholder: string, isFocused: boolean): void {
  line.add(' ⌕ ', { fg: C.dim, bg: C.bar })
  if (text === '' && !isFocused) line.add(placeholder, { fg: C.faint, bg: C.bar })
  else {
    line.add(text, { fg: C.fg, bg: C.bar })
    if (isFocused) line.add(' ', { bg: C.fg })
  }
}

// --- drawing: pickers -------------------------------------------------------------------------

/** `mark` replaces the dot on the current entry: an on or off toggle of the View menu. */
type PickerOption = { id: string; label: string; detail?: string; mark?: string }

/** The modes; or the target's default, the entries matching the filter, and for a base any typed ref no branch is named. */
function pickerOptions(s: State, picker: Picker): PickerOption[] {
  const isMatch = matcher(picker.filter)
  if (picker.kind === 'mode') {
    return MODES.filter(([, label]) => isMatch(label)).map(([id, label, detail]) => ({ id, label, detail }))
  }
  if (picker.kind === 'view') {
    return viewItems(s).map(item => ({ id: item.key, label: item.label, detail: item.key, mark: item.isOn === undefined ? '   ' : item.isOn ? ' ● ' : ' ○ ' }))
  }
  if (picker.kind === 'files') {
    return orderedFiles(s).filter(({ path }) => isMatch(path)).map(({ path }) => ({ id: path, label: clipPath(path, s.geometry.diffWidth - 4) }))
  }

  const { choices } = s.props
  if (choices?.kind !== picker.kind) return []

  const { fallback, typed: typedLabel } = PICKERS[picker.kind]
  const typed = picker.filter.trim()
  const options: PickerOption[] = choices.list.filter(({ label }) => isMatch(label))
  if (typed === '') options.unshift({ id: '', label: fallback })
  if (typedLabel !== undefined && typed !== '' && !choices.list.some(({ id }) => id === typed)) options.push({ id: typed, label: `${typedLabel} "${typed}"` })

  return options
}

function currentId(s: State, kind: PickerKind): string {
  if (kind === 'mode') return s.props.mode
  if (kind === 'files') return headerFile(s)?.path ?? ''
  return isTargetPicker(kind) ? (s.props.picked[kind] ?? '') : ''
}

function drawPicker(s: State, picker: Picker, width: number, rows: number): Line[] {
  const top = s.geometry.bodyTop
  const options = pickerOptions(s, picker)
  const { title, placeholder } = PICKERS[picker.kind]
  const header = new Line(width)

  header.add(` ${title} `, { fg: C.fg, bg: C.bar, bold: true })
  if (picker.kind === 'view') header.add(' Enter or a key toggles, Esc closes', { fg: C.faint, bg: C.bar })
  else addFilterBox(header, picker.filter, placeholder, s.focus === 'picker')
  addButtons(s, header, top, [[' Cancel ', false, { a: 'picker', kind: picker.kind }]], C.bar)
  header.fill({ bg: C.bar })

  const room = rows - 1
  picker.index = Math.max(0, Math.min(picker.index, options.length - 1))
  if (picker.index < picker.scroll) picker.scroll = picker.index
  if (picker.index >= picker.scroll + room) picker.scroll = picker.index - room + 1
  picker.scroll = Math.max(0, Math.min(picker.scroll, options.length - room))

  if (options.length === 0) {
    const line = new Line(width)
    line.add(isTargetPicker(picker.kind) && s.props.choices?.kind !== picker.kind ? '   Loading…' : '   Nothing matches.', { fg: C.dim })
    return [header, line]
  }

  const lines = [header]
  const current = currentId(s, picker.kind)
  const labelWidth = Math.max(...options.map(option => option.label.length)) + 2
  for (let i = 0; i < room; i++) {
    const option = options[picker.scroll + i]
    const line = new Line(width)
    lines.push(line)
    if (option === undefined) continue

    const isHighlighted = picker.scroll + i === picker.index
    const bg = isHighlighted ? C.current : undefined
    line.add(option.mark ?? (option.id === current ? ' ● ' : '   '), { fg: C.accent, bg })
    line.add(option.detail === undefined ? option.label : option.label.padEnd(labelWidth), { fg: option.id === '' ? C.dim : C.fg, bg, bold: isHighlighted })
    if (option.detail !== undefined) line.add(option.detail, { fg: C.dim, bg })
    line.fill({ bg })
    zone(s, top + 1 + i, [0, width], { a: 'choose', id: option.id })
  }

  return lines
}

/** Opens a picker on its current entry; a target's list loads from git only while its picker is open. */
function openPicker(s: State, kind: PickerKind): void {
  if (s.picker !== null) closePicker(s)
  s.picker = { kind, filter: '', index: 0, scroll: 0 }
  s.focus = 'picker'

  if (kind === 'mode' || kind === 'files') s.picker.index = pickerOptions(s, s.picker).findIndex(({ id }) => id === currentId(s, kind))
  if (isTargetPicker(kind)) s.actions.loadChoices(kind)
}

function closePicker(s: State): void {
  if (s.picker !== null && isTargetPicker(s.picker.kind)) s.actions.loadChoices(null)
  s.picker = null
  s.focus = 'diff'
}

function togglePicker(s: State, kind: PickerKind): void {
  if (s.picker?.kind === kind) closePicker(s)
  else openPicker(s, kind)
}

/** The View menu stays open through its toggles, so several can be set in one visit. */
function choose(s: State, picker: Picker, id: string): void {
  if (picker.kind === 'view') {
    const item = viewItems(s).find(entry => entry.key === id)
    if (item !== undefined) perform(s, item.act, false)
    return
  }

  closePicker(s)
  if (picker.kind === 'files') perform(s, { a: 'file', path: id }, false)
  else if (picker.kind === 'mode') chooseMode(s, id as Mode)
  else s.actions.pick(picker.kind, id)
}

/** Commit and Turn show their latest and open their own list to choose another. */
function chooseMode(s: State, mode: Mode): void {
  if (mode !== s.props.mode) s.actions.setMode(mode)
  if (mode === 'commit' || mode === 'turn') openPicker(s, mode)
}

// --- drawing: body -----------------------------------------------------------------------

function drawBody(s: State, width: number, rows: number): Line[] {
  const { props } = s
  const file = props.file
  const message = (text: string, fg: string = C.dim) => {
    const line = new Line(width)
    line.add(`  ${text}`, { fg })
    return [line]
  }

  if (props.error !== null) return message(props.error, C.red)
  if (props.files.length === 0) return message(props.isLoading ? 'Loading…' : 'No changes.')
  if (file === null) return message('Loading…')
  if (file.isBinary) return message('Binary file, not shown.')
  if (file.rows.length === 0 && file.segments === undefined) return message('No content changes (a rename or mode change).')

  // The all-files view mixes shapes; the scrollbar follows the narrowest code column.
  const viewShape = file.segments === undefined ? shapeAt(s, 0) : s.props.options.layout
  const codeRoom = codeWidth(s, width, viewShape)
  const overflow = s.props.options.wrap ? 0 : Math.max(0, s.maxCode - codeRoom + 1)
  s.hscroll = Math.min(s.hscroll, overflow)
  const itemRows = overflow > 0 ? rows - 1 : rows

  const { list, changeStarts } = itemsFor(s)
  if (s.scrollToChange) {
    s.scrollToChange = false
    s.scroll = Math.max(0, (changeStarts[0] ?? 0) - 3)
  }
  if (s.resume !== null) resumeReading(s, s.resume, list.length)
  s.scroll = scrollToComposer(s, s.scroll, list, itemRows)
  s.scroll = Math.max(0, Math.min(s.scroll, list.length - itemRows))
  updateTopSeg(s, list)

  const lines: Line[] = []
  for (let y = 0; y < itemRows; y++) {
    const item = list[s.scroll + y]
    const line = new Line(width)
    if (item !== undefined) drawItem(s, line, item, s.geometry.bodyTop + y)
    lines.push(line)
  }

  s.hbar = null
  if (overflow > 0) lines.push(drawHorizontalBar(s, width, overflow, codeRoom, s.geometry.bodyTop + itemRows))

  return lines
}

/**
 * Where to scroll so the open composer shows, once it opens, moves, grows or the pane shrinks, as when a
 * phone's keyboard comes up. Between those the reader may scroll it away while looking at the code.
 */
function scrollToComposer(s: State, scroll: number, items: (Item | PreviewItem)[], rows: number): number {
  const composer = s.composer
  const seen = composer === null ? '' : `${rows}:${composer.endRow}:${composer.cursor}`
  if (seen === s.composerSeen) return scroll
  s.composerSeen = seen

  const isComposer = (item: Item | PreviewItem) => item.k === 'note' && item.id === COMPOSER_NOTE_ID
  const first = items.findIndex(isComposer)
  if (first < 0) return scroll

  return Math.min(first, Math.max(scroll, items.findLastIndex(isComposer) - rows + 1))
}

function isSelected(s: State, side: Side, index: number): boolean {
  const selection = s.selection ?? (s.composer === null ? null : { ...s.composer, start: s.composer.startRow, end: s.composer.endRow })
  if (selection === null || index < selection.start || index > selection.end) return false

  return shapeAt(s, index) !== 'split' || selection.side === side
}

function hasComment(s: State, side: Side, index: number): boolean {
  const isUnified = shapeAt(s, index) !== 'split'
  return s.props.comments.some(c => (isUnified || c.side === side) && index >= c.startRow && index <= c.endRow)
}

function drawItem(s: State, line: Line, item: Item, y: number): void {
  switch (item.k) {
    case 'line':
      return drawUnified(s, line, item.row, item.part, y)
    case 'pair':
      return drawPair(s, line, item.left, item.right, item.part, y)
    case 'gap':
      return drawGap(s, line, item.from, item.to, y)
    case 'file':
      return drawFileItem(s, line, item.seg, y)
    case 'fold':
      return drawFold(s, line, item.seg, item.count, y)
    case 'group':
      return drawGroupItem(s, line, item.group, item.part)
    case 'note':
      return item.id === COMPOSER_NOTE_ID ? drawComposer(s, line, item.part, y) : drawComment(s, line, item.id, item.part, y)
    case 'end':
      return drawEnd(s, line, y)
  }
}

function rowStyles(kind: RowKind, isSel: boolean) {
  if (isSel) return { lineBg: C.sel, gutterBg: C.selGutter, wordBg: kind === 'removed' ? C.delWord : C.addWord }
  if (kind === 'added') return { lineBg: C.addLine, gutterBg: C.addGutter, wordBg: C.addWord }
  if (kind === 'removed') return { lineBg: C.delLine, gutterBg: C.delGutter, wordBg: C.delWord }
  return { lineBg: undefined, gutterBg: undefined, wordBg: C.addWord }
}

function marker(s: State, side: Side, index: number, kind: RowKind, bg: string | undefined, line: Line): void {
  if (hasComment(s, side, index)) line.add('●', { fg: C.yellow, bg })
  else if (kind === 'added') line.add('+', { fg: C.green, bg })
  else if (kind === 'removed') line.add('-', { fg: C.red, bg })
  else line.add(' ', { bg })
}

/** Draws a row's code, or with wrapping on, the piece of it that visual row `part` shows. */
function drawRowCode(s: State, line: Line, index: number, side: Side, row: Row, part: number, lineBg: string | undefined, wordBg: string): void {
  const tokens = tokensFor(s, index, side)
  const changed = row.kind === 'context' ? null : wordsFor(s, index)
  if (!s.props.options.wrap) return drawCode(line, row.text, tokens, changed, lineBg, wordBg, s.hscroll)

  const piece = piecesFor(s, index)[part]
  if (piece === undefined) return
  const window = new Line(Math.min(line.room, piece.text.length))
  drawCode(window, row.text, tokens, changed, lineBg, wordBg, piece.start)
  line.append(window)
}

function drawUnified(s: State, line: Line, index: number, part: number, y: number): void {
  const row = rowAt(s, index)
  if (row === undefined) return

  const { kind, old: oldNo, new: newNo } = row
  const side: Side = kind === 'removed' ? 'old' : 'new'
  const { lineBg, gutterBg, wordBg } = rowStyles(kind, isSelected(s, side, index))
  const shape = shapeAt(s, index)
  const numbers = gutterText(s, shape === 'one-sided' ? [side === 'old' ? oldNo : newNo] : [oldNo, newNo])

  line.add(part > 0 ? ' '.repeat(gutterWidth(s, shape) - 1) : numbers, { fg: C.faint, bg: gutterBg })
  if (part > 0) line.add(' ', { bg: lineBg })
  else marker(s, side, index, kind, lineBg, line)
  line.add(' ', { bg: lineBg })
  drawRowCode(s, line, index, side, row, part, lineBg, wordBg)
  line.fill({ bg: lineBg })
  zone(s, y, [0, line.width], { a: 'line', side, row: index })
}

function drawHalf(s: State, width: number, index: number, side: Side, part: number): Line {
  const half = new Line(width)
  if (index < 0) {
    half.fill({ bg: C.empty })
    return half
  }

  const row = rowAt(s, index)
  if (row === undefined) return half

  const { kind, old: oldNo, new: newNo } = row
  const { lineBg, gutterBg, wordBg } = rowStyles(kind, isSelected(s, side, index))
  half.add(part > 0 ? ' '.repeat(gutterWidth(s, 'split') - 1) : gutterText(s, [side === 'old' ? oldNo : newNo]), { fg: C.faint, bg: gutterBg })
  if (part > 0) half.add(' ', { bg: lineBg })
  else marker(s, side, index, kind, lineBg, half)
  half.add(' ', { bg: lineBg })
  drawRowCode(s, half, index, side, row, part, lineBg, wordBg)
  half.fill({ bg: lineBg })

  return half
}

function drawPair(s: State, line: Line, left: number, right: number, part: number, y: number): void {
  const leftWidth = Math.floor((line.width - 1) / 2)
  const rightWidth = line.width - leftWidth - 1

  line.append(drawHalf(s, leftWidth, left, 'old', part))
  line.add('│', { fg: C.border })
  line.append(drawHalf(s, rightWidth, right, 'new', part))

  if (left >= 0) zone(s, y, [0, leftWidth], { a: 'line', side: 'old', row: left })
  if (right >= 0) zone(s, y, [leftWidth + 1, line.width], { a: 'line', side: 'new', row: right })
}

function drawGap(s: State, line: Line, from: number, to: number, y: number): void {
  const total = s.props.file?.rows.length ?? 0
  const count = to - from
  const style = { fg: C.dim, bg: C.gap }

  const all = line.add(`  ⇕  ${count} unmodified line${count === 1 ? '' : 's'}  `, style)
  zone(s, y, all, { a: 'gap', from, to })

  if (count > EXPAND_STEP && from > 0) {
    line.add(' ', style)
    zone(s, y, line.add(` ↓ ${EXPAND_STEP} `, { fg: C.accent, bg: C.button }), { a: 'gap', from, to: from + EXPAND_STEP })
  }
  if (count > EXPAND_STEP && to < total) {
    line.add(' ', style)
    zone(s, y, line.add(` ↑ ${EXPAND_STEP} `, { fg: C.accent, bg: C.button }), { a: 'gap', from: to - EXPAND_STEP, to })
  }
  line.fill(style)
}

function boxLine(s: State, line: Line, row: number, part: number, height: number, draw: (inner: Line) => void, title?: string): void {
  const indent = noteIndent(s, row) + 1
  const width = noteWidth(s, row)
  const border = { fg: C.border }

  line.add(' '.repeat(indent))
  if (part === 0) {
    line.add('╭─', border)
    line.add(` ${title ?? ''} `, { fg: C.dim })
    line.add('─'.repeat(Math.max(0, indent + width - 1 - line.used)), border)
    line.add('╮', border)
    return
  }
  if (part === height - 1) {
    line.add(`╰${'─'.repeat(width - 2)}╯`, border)
    return
  }

  line.add('│ ', border)
  const inner = new Line(width - 4)
  draw(inner)
  inner.fill()
  line.append(inner)
  line.add(' │', border)
}

/** Buttons flush right in a box's last row, one cell apart; `indent` is where the box's inside starts on screen. */
function boxButtonsWidth(buttons: [string, Style, Action][]): number {
  return buttons.reduce((sum, [label]) => sum + label.length + 1, -1)
}

function addBoxButtons(s: State, inner: Line, y: number, indent: number, buttons: [string, Style, Action][]): void {
  inner.fill({}, inner.width - boxButtonsWidth(buttons))
  buttons.forEach(([label, style, act], i) => {
    if (i > 0) inner.add(' ')
    zone(s, y, inner.add(label, style), act, indent)
  })
}

function drawComment(s: State, line: Line, id: number, part: number, y: number): void {
  const comment = s.props.comments.find(c => c.id === id)
  if (comment === undefined) return

  const lines = commentLines(s, comment)
  const height = lines.length + 3
  const indent = noteIndent(s, comment.endRow) + 3

  boxLine(s, line, comment.endRow, part, height, inner => {
    if (part <= lines.length) {
      inner.add(lines[part - 1]?.text ?? '', { fg: C.fg })
      return
    }
    if (comment.sent !== undefined) {
      inner.add('sent to Claude', { fg: C.faint })
      const outcome = comment.sent === 'changed' ? ' lines changed since ' : ' not changed yet '
      inner.fill({}, inner.width - outcome.length)
      inner.add(outcome, { fg: comment.sent === 'changed' ? C.green : C.yellow, bg: C.button })
      return
    }
    inner.add('in prompt as ', { fg: C.faint })
    inner.add(comment.token, { fg: C.dim })
    addBoxButtons(s, inner, y, indent, [
      [' Edit ', { fg: C.fg, bg: C.button }, { a: 'edit', id }],
      [' Delete ', { fg: C.red, bg: C.button }, { a: 'delete', id }],
    ])
  }, `${comment.sent === undefined ? 'You' : 'Sent'} · ${comment.token}`)
}

function rangeLabel(s: State, composer: Composer): string {
  const numbers: number[] = []
  for (let i = composer.startRow; i <= composer.endRow; i++) {
    const row = rowAt(s, i)
    const number = row === undefined ? 0 : row[composer.side]
    if (number > 0) numbers.push(number)
  }
  if (numbers.length === 0) return ''
  const first = Math.min(...numbers)
  const last = Math.max(...numbers)

  return `${first === last ? `L${first}` : `L${first}-${last}`}${composer.side === 'old' ? ' (before)' : ''}`
}

function drawComposer(s: State, line: Line, part: number, y: number): void {
  const composer = s.composer
  if (composer === null) return

  const lines = composerLines(s)
  const shown = Math.max(1, lines.length)
  const height = shown + 3
  const indent = noteIndent(s, composer.endRow) + 3
  const isFocused = s.focus === 'composer'

  boxLine(s, line, composer.endRow, part, height, inner => {
    if (part <= shown) {
      const piece = lines[part - 1]
      if (composer.text === '' && part === 1) {
        if (isFocused) inner.add(' ', { bg: C.fg })
        inner.add(isFocused ? 'Write a comment…' : 'Click here to write a comment…', { fg: C.faint })
      } else if (piece !== undefined) {
        const cursorAt = composer.cursor - piece.start
        const isCursorLine = isFocused && cursorAt >= 0 && cursorAt <= piece.text.length && (part === shown || cursorAt < piece.text.length)
        if (isCursorLine) {
          inner.add(piece.text.slice(0, cursorAt), { fg: C.fg })
          inner.add(piece.text[cursorAt] ?? ' ', { fg: '#0d1117', bg: C.fg })
          inner.add(piece.text.slice(cursorAt + 1), { fg: C.fg })
        } else {
          inner.add(piece.text, { fg: C.fg })
        }
      }
      zone(s, y, [indent, indent + inner.width], { a: 'composer-focus' })
      return
    }

    const isEditing = composer.editing !== undefined
    const keys = `Enter ${isEditing ? 'saves' : 'adds'} · Shift+Enter new line`
    const hint = canExtend(s, composer) ? 'Tap a line to extend' : isCompact(s) ? '' : keys
    const buttons: [string, Style, Action][] = [
      [' Cancel ', { fg: C.dim, bg: C.button }, { a: 'composer-cancel' }],
      [isEditing ? ' Save ' : ' Comment ', { fg: '#0d1117', bg: C.fg, bold: true }, { a: 'composer-submit' }],
    ]
    inner.add(clip(hint, inner.width - boxButtonsWidth(buttons) - 1), { fg: C.faint })
    addBoxButtons(s, inner, y, indent, buttons)
  }, composerTitle(s, composer))
}

function composerTitle(s: State, composer: Composer): string {
  const edited = s.props.comments.find(c => c.id === composer.editing)
  return edited === undefined ? `New comment · ${rangeLabel(s, composer)}` : `Edit comment · ${edited.token}`
}

const VIEWED_BUTTON = ' ☐ Viewed '.length

function addViewedButton(s: State, line: Line, y: number, path: string): void {
  const isViewed = s.props.viewed.has(path)
  const style = isViewed ? { fg: C.fg, bg: C.button, bold: true } : { fg: C.dim, bg: C.button }
  zone(s, y, line.add(isViewed ? ' ✓ Viewed ' : ' ☐ Viewed ', style), { a: 'viewed', path })
}

function drawFileItem(s: State, line: Line, seg: number, y: number): void {
  const segment = segmentsOf(s)?.[seg]
  if (segment === undefined) return

  const { path, status, added, removed, isBinary, start, end } = segment
  const textEnd = line.width - VIEWED_BUTTON - 1
  const plus = `  +${added}`
  const minus = ` -${removed}`
  const note = isBinary ? '  binary file, not shown' : s.props.viewed.has(path) ? '  viewed' : start === end ? '  no content changes' : ''

  addFilePath(line, clipPath(path, textEnd - 3 - plus.length - minus.length), status, C.bar)
  line.add(plus, { fg: C.green, bg: C.bar })
  line.add(minus, { fg: C.red, bg: C.bar })
  line.add(clip(note, textEnd - line.used), { fg: C.faint, bg: C.bar })
  line.fill({ bg: C.bar }, textEnd)
  zone(s, y, [0, line.used], { a: 'open', path })
  addViewedButton(s, line, y, path)
  line.fill({ bg: C.bar })
}

function drawGroupItem(s: State, line: Line, group: number, part: number): void {
  const found = readyGroups(s)?.[group]
  if (found === undefined) return

  if (part === 1) {
    line.add(`    ${found.why}`, { fg: C.dim })
    return
  }
  line.add(` ${group + 1}. ${found.title}`, { fg: C.accent, bold: true })
  line.add(`  ${found.paths.length} file${found.paths.length === 1 ? '' : 's'}`, { fg: C.faint })
}

function drawFold(s: State, line: Line, seg: number, count: number, y: number): void {
  const path = segmentsOf(s)?.[seg]?.path
  const style = { fg: C.dim, bg: C.gap }

  line.add(`  ⇕  ${count} unmodified line${count === 1 ? '' : 's'}  `, style)
  line.add('open the file alone to expand', { fg: C.faint, bg: C.gap })
  line.fill(style)
  if (path !== undefined) zone(s, y, [0, line.width], { a: 'open', path })
}

function drawEnd(s: State, line: Line, y: number): void {
  if (segmentsOf(s) !== undefined) {
    line.add('  ── end of changes ──', { fg: C.faint })
    return
  }

  const files = orderedFiles(s)
  const index = files.findIndex(entry => entry.path === s.props.file?.path)
  const next = files[index + 1]

  line.add('  ── end of file ──   ', { fg: C.faint })
  addViewedButton(s, line, y, s.props.file?.path ?? '')
  if (next !== undefined) {
    line.add('   ')
    zone(s, y, line.add(` Next file ▸ ${next.path.split('/').pop()} `, { fg: C.accent, bg: C.button }), { a: 'step-file', by: 1 })
  }
}

/** Cells the code of one line gets: the whole diff column, or one half of it, less the gutter. */
function codeWidth(s: State, width: number, shape: Shape): number {
  const column = shape === 'split' ? Math.floor((width - 1) / 2) : width
  return Math.max(1, column - gutterWidth(s, shape) - 1)
}

function drawHorizontalBar(s: State, width: number, overflow: number, room: number, y: number): Line {
  const line = new Line(width)
  zone(s, y, line.add(' ◂ ', { fg: C.fg, bg: C.button }), { a: 'hscroll', by: -HSCROLL_STEP })

  const track = width - 6
  const thumb = Math.max(2, Math.round((track * room) / (room + overflow)))
  const at = Math.round(((track - thumb) * s.hscroll) / overflow)
  const x = line.used
  line.add(' '.repeat(at), { bg: C.gap })
  line.add(' '.repeat(thumb), { bg: C.dim })
  line.fill({ bg: C.gap }, width - 3)
  zone(s, y, [x, x + track], { a: 'hbar' })
  zone(s, y, line.add(' ▸ ', { fg: C.fg, bg: C.button }), { a: 'hscroll', by: HSCROLL_STEP })

  s.hbar = { x: x + at, track, thumb, max: overflow }
  return line
}

// --- drawing: tree and preview ---------------------------------------------------------------

const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const SPINNER_MS = 100

/** The spinner's frame for now; drawing one asks for the next frame, since nothing else redraws while Haiku works. */
function spinner(s: State): string {
  if (s.spinnerTick === null) {
    s.spinnerTick = setTimeout(() => {
      s.spinnerTick = null
      redraw(s)
    }, SPINNER_MS)
    s.spinnerTick.unref()
  }

  return SPINNER[Math.floor(Date.now() / SPINNER_MS) % SPINNER.length] ?? ''
}

function groupingStatus(s: State, width: number): Line[] {
  const grouping = s.props.grouping
  if (grouping?.status !== 'pending') return []

  const seconds = Math.floor((Date.now() - grouping.startedAt) / 1000)
  const title = new Line(width)
  title.add(` ${spinner(s)} Grouping with Haiku`, { fg: C.accent, bold: true })
  title.add(` · ${seconds}s`, { fg: C.faint })
  const note = new Line(width)
  note.add('   showing folders until done', { fg: C.faint })

  return [title, note]
}

function readyGroups(s: State): FileGroup[] | null {
  const grouping = s.props.grouping
  return grouping?.status === 'ready' ? grouping.groups : null
}

/** The files under their groups once those are in, else under their folders. */
function fileRows(s: State, filter: string, closed: ReadonlySet<string>): TreeRow[] {
  const groups = readyGroups(s)
  return groups === null ? buildTree(s.props.files, filter, closed) : buildGroupedTree(s.props.files, groups, filter, closed)
}

function treeRows(s: State): TreeRow[] {
  return fileRows(s, s.search, s.closedDirs)
}

/** A drawn row of the tree: a tree row or a later piece of a wrapped group title, or null for the space between groups. */
type TreeLine = { row: TreeRow; isFirst: boolean; text: string } | null

function groupCount(row: Extract<TreeRow, { kind: 'group' }>): string {
  return ` ${row.count} `
}

/** The tree's rows as drawn `width` cells wide: group titles wrap rather than lose their ends. */
function treeLines(s: State, width: number): TreeLine[] {
  return treeRows(s).flatMap((row, i): TreeLine[] => {
    if (row.kind !== 'group') return [{ row, isFirst: true, text: row.name }]

    // The title sits past ` ▾ ` and leaves room for the count on its first line.
    const pieces = wrapText(row.name, width - 3 - groupCount(row).length)
    const lines = pieces.map((piece, part) => ({ row, isFirst: part === 0, text: piece.text.trimEnd() }))
    return i === 0 ? lines : [null, ...lines]
  })
}

/** A folder cut from the left to fit `room`, at a slash where one fits, keeping the part nearest the file; empty when too little fits. */
function fitDir(dir: string, room: number): string {
  if (dir.length <= room) return dir
  if (room < 4) return ''

  const tail = dir.slice(dir.length - room + 1)
  const slash = tail.indexOf('/')
  return `…${slash < 0 ? tail : tail.slice(slash)}`
}

function drawTree(s: State, width: number, height: number, xOffset: number): Line[] {
  const lines: Line[] = []
  const search = new Line(width)

  addFilterBox(search, s.search, 'Filter files…', s.focus === 'search')
  search.fill({ bg: C.bar })
  zone(s, 1, [0, width], { a: 'search-focus' }, xOffset)
  lines.push(search)
  const status = groupingStatus(s, width)
  lines.push(...status)

  const drawn = treeLines(s, width)
  const room = height - lines.length
  s.treeScroll = Math.max(0, Math.min(s.treeScroll, drawn.length - room))

  for (let i = 0; i < room; i++) {
    const entry = drawn[s.treeScroll + i]
    const line = new Line(width)
    lines.push(line)
    if (entry === undefined || entry === null) continue

    const { row } = entry
    // The tree starts on the screen's second row, so the line just added sits at its count.
    const y = lines.length
    const indent = ' '.repeat(1 + row.depth * 2)
    if (row.kind === 'group') {
      const arrow = !entry.isFirst ? ' ' : row.isOpen ? '▾' : '▸'
      line.add(`${indent}${arrow} ${entry.text}`, { fg: C.fg, bold: true })
      if (entry.isFirst) {
        line.fill({}, width - groupCount(row).length)
        line.add(groupCount(row), { fg: C.faint })
      }
      zone(s, y, [0, width], { a: 'dir', path: row.path }, xOffset)
      continue
    }
    if (row.kind === 'dir') {
      line.add(`${indent}${row.isOpen ? '▾' : '▸'} ${row.name}`, { fg: C.dim })
      zone(s, y, [0, width], { a: 'dir', path: row.path }, xOffset)
      continue
    }

    const { path, status, added, removed } = row.entry
    const isCurrent = path === currentPath(s)
    const bg = isCurrent ? C.current : undefined
    const color = { A: C.green, D: C.red, R: C.yellow, M: C.fg }[status]
    const counts = `${added > 0 ? `+${added}` : ''}${removed > 0 ? ` -${removed}` : ''} `
    const nameRoom = () => Math.max(0, width - line.used - counts.length - 1)

    const isViewed = s.props.viewed.has(path)
    line.add(indent, { bg })
    line.add(isViewed ? '✓ ' : '  ', { fg: C.green, bg })
    line.add(row.name.slice(0, Math.max(1, nameRoom())), { fg: isViewed ? C.faint : color, bg, bold: isCurrent })
    const dir = fitDir(row.dir ?? '', nameRoom() - 2)
    if (dir !== '') line.add(`  ${dir}`, { fg: C.faint, bg })
    line.fill({ bg }, width - counts.length)
    const plus = counts.indexOf(' -')
    line.add(plus < 0 ? counts : counts.slice(0, plus), { fg: C.green, bg })
    if (plus >= 0) line.add(counts.slice(plus), { fg: C.red, bg })
    line.fill({ bg })
    zone(s, y, [0, width], { a: 'file', path }, xOffset)
  }

  return lines
}

function revealCurrentInTree(s: State): void {
  if (!s.props.options.showTree) return

  const path = currentPath(s)
  const index = treeLines(s, s.geometry.treeWidth).findIndex(entry => entry?.row.kind === 'file' && entry.row.entry.path === path)
  const room = Math.max(1, s.geometry.height - 2)
  if (index >= 0 && (index < s.treeScroll || index >= s.treeScroll + room)) {
    s.treeScroll = Math.max(0, index - Math.floor(room / 3))
  }
}

function isPreviewing(s: State): boolean {
  const file = s.props.file
  return s.props.options.preview && file !== null && file.segments === undefined && languageFor(file.path) === 'markdown'
}

// Long enough to say what was highlighted; a comment on a whole document needs no more.
const MAX_QUOTE = 2_000

/** The new side's markdown laid out at `width`, kept until the file or the width changes. */
function previewLines(s: State, file: ViewerFile, width: number): NonNullable<State['preview']> {
  const sig = `${s.fileKey}:${width}`
  if (s.preview?.sig !== sig) {
    const kept = file.rows.flatMap((row, i) => (row.kind === 'removed' ? [] : [{ text: row.text, row: i }]))
    s.preview = { sig, lines: renderMarkdown(kept.map(one => one.text).join('\n'), width), rowOf: kept.map(one => one.row) }
  }

  return s.preview
}

/** The rendered rows with each comment, and the open composer, after the rows of the block it is on. */
function previewItems(s: State, lines: MdLine[], rowOf: number[]): PreviewItem[] {
  const notes = shownComments(s).map(c => ({ id: c.id, endRow: c.endRow, height: commentLines(s, c).length + 3 }))
  if (s.composer !== null) notes.push({ id: COMPOSER_NOTE_ID, endRow: s.composer.endRow, height: Math.max(1, composerLines(s).length) + 3 })

  const items: PreviewItem[] = []
  lines.forEach((line, index) => {
    items.push({ k: 'md', line: index })
    const isBlockEnd = lines[index + 1]?.from !== line.from || index === lines.length - 1
    if (!isBlockEnd) return
    for (const note of notes) {
      const isHere = (rowOf[line.from] ?? -1) <= note.endRow && note.endRow <= (rowOf[line.to] ?? -1)
      if (isHere) for (let part = 0; part < note.height; part++) items.push({ k: 'note', id: note.id, part })
    }
  })

  return items
}

function drawPreview(s: State, width: number, rows: number): Line[] {
  const { lines, rowOf } = s.props.file === null ? { lines: [], rowOf: [] } : previewLines(s, s.props.file, width - 2)
  const items = previewItems(s, lines, rowOf)

  const room = width - 2
  const widest = Math.max(0, ...lines.filter(line => line.slides).map(line => spanWidth(line.spans)))
  const overflow = Math.max(0, widest - room)
  s.hscroll = Math.min(s.hscroll, overflow)
  const itemRows = overflow > 0 ? rows - 1 : rows
  s.previewScroll = scrollToComposer(s, s.previewScroll, items, itemRows)
  s.previewScroll = Math.max(0, Math.min(s.previewScroll, items.length - itemRows))

  const out: Line[] = []
  for (let i = 0; i < itemRows; i++) {
    const item = items[s.previewScroll + i]
    const y = s.geometry.bodyTop + i
    const line = new Line(width)
    if (item?.k === 'md') drawPreviewLine(s, line, item.line, y)
    else if (item?.k === 'note') {
      if (item.id === COMPOSER_NOTE_ID) drawComposer(s, line, item.part, y)
      else drawComment(s, line, item.id, item.part, y)
    }
    out.push(line)
  }

  s.hbar = null
  if (overflow > 0) out.push(drawHorizontalBar(s, width, overflow, room, s.geometry.bodyTop + itemRows))
  return out
}

function drawPreviewLine(s: State, line: Line, index: number, y: number): void {
  const md = s.preview?.lines[index]
  if (md === undefined) return

  const shift = md.slides === true ? s.hscroll : 0
  const [from, to] = selectedColumns(s, index) ?? [0, 0]
  let col = 0
  line.add(' ')
  for (const span of md.spans) {
    // Each span splits where the highlight starts and ends, in the columns of the unscrolled text.
    const cuts = [col, from, to, col + span.t.length].filter(at => at >= col && at <= col + span.t.length).sort((a, b) => a - b)
    for (let i = 0; i + 1 < cuts.length; i++) {
      const [start, end] = [cuts[i] as number, cuts[i + 1] as number]
      const shown = span.t.slice(Math.max(start, shift) - col, end - col)
      if (end <= shift || shown === '') continue
      line.add(shown, start >= from && end <= to ? { ...span, bg: C.sel } : span)
    }
    col += span.t.length
  }
  zone(s, y, [0, line.width], { a: 'md', line: index })
}

/** The highlighted columns of a rendered row, [from, to), or null where it has none. */
function selectedColumns(s: State, index: number): [number, number] | null {
  const sel = s.previewSel
  if (sel === null) return null

  const [start, end] = ordered(sel.anchor, sel.head)
  if (index < start.line || index > end.line) return null
  return [index === start.line ? start.col : 0, index === end.line ? end.col + 1 : Number.MAX_SAFE_INTEGER]
}

function ordered(a: MdPoint, b: MdPoint): [MdPoint, MdPoint] {
  const isBefore = a.line < b.line || (a.line === b.line && a.col <= b.col)
  return isBefore ? [a, b] : [b, a]
}

/** Where a pointer at `x` lands in a rendered row, past the one-cell margin and any sideways scroll. */
function mdPoint(s: State, line: number, x: number): MdPoint {
  const shift = s.preview?.lines[line]?.slides === true ? s.hscroll : 0
  return { line, col: Math.max(0, x - 1 + shift) }
}

/** The highlighted text, rows joined by spaces, or '' when nothing but space is highlighted. */
function selectedText(s: State): string {
  const lines = s.preview?.lines ?? []
  const parts = lines.flatMap((line, index) => {
    const cols = selectedColumns(s, index)
    return cols === null ? [] : [line.spans.map(span => span.t).join('').slice(cols[0], cols[1]).trim()]
  })
  const text = parts.filter(part => part !== '').join(' ').replace(/\s+/g, ' ')

  return text.length > MAX_QUOTE ? `${text.slice(0, MAX_QUOTE)}…` : text
}

/** Opens the composer on the source lines under the highlight, quoting what was highlighted. */
function openPreviewComposer(s: State, sel: MdSelection): void {
  const quote = selectedText(s)
  const preview = s.preview
  if (quote === '' || preview === null) {
    s.previewSel = null
    return
  }

  const [start, end] = ordered(sel.anchor, sel.head)
  const startRow = preview.rowOf[preview.lines[start.line]?.from ?? 0] ?? 0
  const endRow = preview.rowOf[preview.lines[end.line]?.to ?? 0] ?? startRow
  s.composer = { side: 'new', startRow, endRow, text: s.draft, cursor: s.draft.length, quote }
  s.focus = 'composer'
}

/** Moves the preview for a scrolling key; false for any other key. */
function scrollPreview(s: State, key: string): boolean {
  const page = Math.max(1, s.geometry.bodyRows - 2)
  const steps: Record<string, number> = { down: 1, j: 1, up: -1, k: -1, pagedown: page, ' ': page, space: page, pageup: -page }
  const step = steps[key]

  if (key === 'home' || key === 'g') s.previewScroll = 0
  else if (key === 'end' || key === 'G') s.previewScroll = Number.MAX_SAFE_INTEGER
  else if (step !== undefined) s.previewScroll = Math.max(0, s.previewScroll + step)
  else return false

  return true
}

// --- input -----------------------------------------------------------------------------------

function zoneAt(s: State, x: number, y: number): Zone | undefined {
  for (let i = s.zones.length - 1; i >= 0; i--) {
    const z = s.zones[i] as Zone
    if (z.y === y && x >= z.x0 && x < z.x1) return z
  }

  return undefined
}

function sideForRange(s: State, side: Side, start: number, end: number): Side {
  if (shapeAt(s, start) === 'split') return side
  for (let i = start; i <= end; i++) {
    if (rowAt(s, i)?.kind !== 'removed') return 'new'
  }

  return 'old'
}

/** Whether a tap on another line sets where the comment ends, since a drag scrolls on a phone. */
function canExtend(s: State, composer: Composer): boolean {
  return isCompact(s) && composer.editing === undefined && composer.quote === undefined
}

function openComposer(s: State, selection: Selection): void {
  // A comment belongs to one file, so it stays within the file the selection began in.
  const seg = segmentsOf(s)?.[segmentAt(s, selection.anchor)]
  const start = seg === undefined ? selection.start : Math.max(selection.start, seg.start)
  const end = seg === undefined ? selection.end : Math.min(selection.end, seg.end - 1)

  s.composer = {
    side: sideForRange(s, selection.side, start, end),
    startRow: start,
    endRow: end,
    text: s.draft,
    cursor: s.draft.length,
  }
  s.selection = null
  s.focus = 'composer'
}

function openEditor(s: State, id: number): void {
  const comment = s.props.comments.find(c => c.id === id)
  if (comment === undefined) return

  const { side, startRow, endRow, text } = comment
  s.composer = { side, startRow, endRow, text, cursor: text.length, editing: id }
  s.selection = null
  s.focus = 'composer'
}

function submitComposer(s: State): void {
  const composer = s.composer
  if (composer === null || composer.text.trim() === '') return

  if (composer.editing !== undefined) s.actions.editComment(composer.editing, composer.text)
  else s.actions.addComment({ key: s.props.file?.key ?? '', side: composer.side, startRow: composer.startRow, endRow: composer.endRow, text: composer.text, quote: composer.quote })
  s.composer = null
  s.previewSel = null
  s.draft = ''
  s.focus = 'diff'
}

/** Scrolls the all-files view to a file's header. */
function scrollToFile(s: State, seg: number): void {
  const start = s.items?.fileStarts[seg]
  if (start === undefined) return
  s.scroll = start
  setTopSeg(s, seg)
}

function stepFile(s: State, by: number): void {
  const segments = segmentsOf(s)
  if (segments !== undefined) {
    const start = s.items?.fileStarts[s.topSeg] ?? 0
    const isInsideFile = by < 0 && s.scroll > start
    scrollToFile(s, isInsideFile ? s.topSeg : Math.max(0, Math.min(segments.length - 1, s.topSeg + by)))
    return
  }

  const files = orderedFiles(s)
  const index = files.findIndex(entry => entry.path === s.props.file?.path)
  const next = files[Math.max(0, Math.min(files.length - 1, index + by))]
  if (next !== undefined && next.path !== s.props.file?.path) s.actions.selectFile(next.path)
}

function perform(s: State, act: Action, shift: boolean): void {
  switch (act.a) {
    case 'line': {
      const current = s.selection
      const composer = s.composer
      const shiftAnchor = shift && current !== null && current.side === act.side ? current.anchor : act.row
      const anchor = composer !== null && canExtend(s, composer) ? composer.startRow : shiftAnchor
      s.selection = { side: act.side, anchor, start: Math.min(anchor, act.row), end: Math.max(anchor, act.row), isDragging: true }
      s.focus = 'diff'
      return
    }
    case 'gap':
      s.revealed.fill(1, act.from, act.to)
      s.revealedVersion += 1
      return
    case 'run':
      act.run(s.actions)
      return
    case 'edit':
      openEditor(s, act.id)
      return
    case 'delete':
      s.actions.deleteComment(act.id)
      return
    case 'viewed':
      s.actions.toggleViewed(act.path)
      return
    case 'composer-focus':
      s.focus = 'composer'
      return
    case 'composer-cancel':
      s.composer = null
      s.previewSel = null
      s.draft = ''
      s.focus = 'diff'
      return
    case 'composer-submit':
      submitComposer(s)
      return
    case 'search-focus':
      s.focus = 'search'
      return
    case 'dir':
      if (s.closedDirs.has(act.path)) s.closedDirs.delete(act.path)
      else s.closedDirs.add(act.path)
      return
    case 'step-file':
      stepFile(s, act.by)
      return
    case 'md':
      return
    case 'file': {
      const seg = segmentsOf(s)?.findIndex(segment => segment.path === act.path) ?? -1
      if (seg >= 0) scrollToFile(s, seg)
      else s.actions.selectFile(act.path)
      return
    }
    case 'open':
      s.actions.openFile(act.path)
      return
    case 'preview':
      // Previewing shows one file, so the all-files view hands over to that file first.
      if (segmentsOf(s) !== undefined) {
        const path = currentPath(s)
        if (path !== undefined) s.actions.openFile(path)
        if (!s.props.options.preview) s.actions.toggle('preview')
      } else {
        s.actions.toggle('preview')
      }
      return
    case 'hscroll':
      s.hscroll = Math.max(0, s.hscroll + act.by)
      s.focus = 'diff'
      return
    case 'hbar':
    case 'divider':
      s.focus = 'diff'
      return
    case 'picker':
      togglePicker(s, act.kind)
      return
    case 'choose':
      if (s.picker !== null) choose(s, s.picker, act.id)
      return
  }
}

function onPointer(s: State, event: PointerEvent): void {
  const selection = s.selection

  if (event.type === 'down' && event.button === 'left') {
    const hit = zoneAt(s, event.x, event.y)
    if (hit === undefined) return
    perform(s, hit.act, event.shift === true)
    if (hit.act.a === 'hbar' && s.hbar !== null) grabScrollbar(s, s.hbar, event.x)
    if (hit.act.a === 'line') s.drag = { kind: 'select' }
    if (hit.act.a === 'divider') s.drag = { kind: 'tree' }
    if (hit.act.a === 'md' && s.composer === null) {
      const point = mdPoint(s, hit.act.line, event.x)
      s.previewSel = { anchor: point, head: point, isDragging: true }
    }
    redraw(s)
    return
  }

  const drag = s.drag
  if (event.type === 'move' && drag?.kind === 'tree') {
    s.treeWidth = clampTree(s.geometry.width - event.x - 1, s.geometry.width)
    redraw(s)
    return
  }
  if (event.type === 'up' && drag?.kind === 'tree') {
    s.drag = null
    if (s.treeWidth !== undefined) s.actions.setTreeWidth(s.treeWidth)
    redraw(s)
    return
  }
  if (event.type === 'move' && drag?.kind === 'hbar') {
    s.hscroll = Math.max(0, Math.round(drag.hscroll + (event.x - drag.x) * drag.perCell))
    redraw(s)
    return
  }
  if (event.type === 'up' && drag?.kind === 'hbar') {
    s.drag = null
    return
  }

  const highlight = s.previewSel
  if (event.type === 'move' && highlight?.isDragging === true) {
    const { bodyTop, height } = s.geometry
    if (event.y < bodyTop) s.previewScroll = Math.max(0, s.previewScroll - 1)
    if (event.y >= height) s.previewScroll += 1
    const hit = zoneAt(s, event.x, Math.max(bodyTop, Math.min(height - 1, event.y)))
    if (hit?.act.a === 'md') highlight.head = mdPoint(s, hit.act.line, event.x)
    redraw(s)
    return
  }
  if (event.type === 'up' && highlight?.isDragging === true) {
    highlight.isDragging = false
    // A click without a drag highlights nothing, so it leaves links and scrolling alone.
    const isClick = highlight.anchor.line === highlight.head.line && highlight.anchor.col === highlight.head.col
    if (isClick) s.previewSel = null
    else openPreviewComposer(s, highlight)
    redraw(s)
    return
  }

  if (event.type === 'move' && selection?.isDragging === true) {
    const { bodyTop, height } = s.geometry
    if (event.y < bodyTop) s.scroll = Math.max(0, s.scroll - 1)
    if (event.y >= height) s.scroll += 1
    const hit = zoneAt(s, event.x, Math.max(bodyTop, Math.min(height - 1, event.y)))
    if (hit?.act.a === 'line' && hit.act.side === selection.side) {
      selection.start = Math.min(selection.anchor, hit.act.row)
      selection.end = Math.max(selection.anchor, hit.act.row)
    }
    redraw(s)
    return
  }

  if (event.type === 'up' && selection?.isDragging === true) {
    s.drag = null
    selection.isDragging = false
    openComposer(s, selection)
    redraw(s)
  }
}

/** A press on the thumb drags it; on the track either side, it pages that way and then drags. */
function grabScrollbar(s: State, bar: NonNullable<State['hbar']>, x: number): void {
  const page = Math.max(HSCROLL_STEP, Math.round((bar.max * bar.thumb) / Math.max(1, bar.track - bar.thumb)))
  if (x < bar.x) s.hscroll = Math.max(0, s.hscroll - page)
  else if (x >= bar.x + bar.thumb) s.hscroll = Math.min(bar.max, s.hscroll + page)

  const perCell = bar.max / Math.max(1, bar.track - bar.thumb)
  s.drag = { kind: 'hbar', x, hscroll: s.hscroll, perCell }
}

const SPECIAL = new Set([
  'up', 'down', 'left', 'right', 'return', 'enter', 'tab', 'backspace', 'delete', 'pageup', 'pagedown', 'home', 'end', 'escape',
])

function isText(event: KeyEvent): boolean {
  return event.ctrl !== true && event.meta !== true && !SPECIAL.has(event.key) && event.key.length > 0
}

function typedText(event: KeyEvent): string {
  return event.key === 'space' ? ' ' : event.key.replace(/\r\n?/g, '\n')
}

function onKey(s: State, event: KeyEvent): void {
  if (event.key === 'escape') escape(s)
  else if (s.focus === 'composer' && s.composer !== null) editComposer(s, s.composer, event)
  else if (s.focus === 'picker' && s.picker !== null) editPicker(s, s.picker, event)
  else if (s.focus === 'search') editSearch(s, event)
  else navigate(s, event)
  redraw(s)
}

/** Backs out one level: the comment being written, an open picker, the search, a selection, an opened file, then back to Claude. */
function escape(s: State): void {
  if (s.composer !== null) perform(s, { a: 'composer-cancel' }, false)
  else if (s.picker !== null) closePicker(s)
  else if (s.focus === 'search') s.focus = 'diff'
  else if (s.selection !== null || s.previewSel !== null) {
    s.selection = null
    s.previewSel = null
  } else if (s.props.view === 'opened') s.actions.showAll()
  else s.actions.leave()
}

function editComposer(s: State, composer: Composer, event: KeyEvent): void {
  const { text, cursor } = composer
  const isEnter = event.key === 'return' || event.key === 'enter'

  if (isEnter && event.shift !== true) return submitComposer(s)

  const typed = isEnter ? '\n' : isText(event) ? typedText(event) : ''
  const edit = typed === '' ? editText(text, cursor, event) : { text: text.slice(0, cursor) + typed + text.slice(cursor), cursor: cursor + typed.length }
  if (edit === null) return

  composer.text = edit.text
  composer.cursor = edit.cursor
  // The draft carries a new comment's text to wherever the next selection opens it; an edit stays on its comment.
  if (composer.editing === undefined) s.draft = edit.text
}

/** A one-line filter typed at its end: the text after a typed or deleting key, or null for any other key. */
function editFilter(text: string, event: KeyEvent): string | null {
  if (isText(event)) return text + typedText(event)
  const edit = editText(text, text.length, event)
  return edit === null || edit.text === text ? null : edit.text
}

function editSearch(s: State, event: KeyEvent): void {
  if (event.key === 'return' || event.key === 'enter') {
    const first = treeRows(s).find(row => row.kind === 'file')
    if (first?.kind === 'file') s.actions.selectFile(first.entry.path)
    s.focus = 'diff'
  } else if (event.key === 'down' || event.key === 'tab') {
    s.focus = 'diff'
  } else {
    const search = editFilter(s.search, event)
    if (search === null) return
    s.search = search
    s.treeScroll = 0
  }
}

function editPicker(s: State, picker: Picker, event: KeyEvent): void {
  if (picker.kind === 'view') return pressViewMenu(s, picker, event.key)

  const key = event.key
  if (key === 'return' || key === 'enter') {
    const option = pickerOptions(s, picker)[picker.index]
    if (option !== undefined) choose(s, picker, option.id)
  } else if (key === 'escape') closePicker(s)
  else if (key === 'up') picker.index = Math.max(0, picker.index - 1)
  else if (key === 'down' || key === 'tab') picker.index += 1
  else {
    const filter = editFilter(picker.filter, event)
    if (filter === null) return
    picker.filter = filter
    picker.index = 0
  }
}

/** The View menu has no filter, so each item's own key presses it. */
function pressViewMenu(s: State, picker: Picker, key: string): void {
  const option = pickerOptions(s, picker)[picker.index]
  if ((key === 'return' || key === 'enter' || key === 'space') && option !== undefined) choose(s, picker, option.id)
  else if (key === 'escape' || key === 'V') closePicker(s)
  else if (key === 'up' || key === 'k') picker.index = Math.max(0, picker.index - 1)
  else if (key === 'down' || key === 'j' || key === 'tab') picker.index += 1
  else choose(s, picker, key)
}

function navigate(s: State, event: KeyEvent): void {
  const page = Math.max(1, s.geometry.bodyRows - 2)
  const key = event.key
  const changeStarts = s.items?.changeStarts ?? []
  const kind = pickKind(s.props.mode)
  const byNumber = /^[1-9]$/.test(key) ? MODES[Number(key) - 1]?.[0] : undefined

  if (isPreviewing(s) && scrollPreview(s, key)) return

  const jumpChange = (forward: boolean) => {
    const target = forward ? changeStarts.find(i => i > s.scroll + 3) : [...changeStarts].reverse().find(i => i < s.scroll + 3)
    if (target !== undefined) s.scroll = Math.max(0, target - 3)
  }

  if (key === 'down' || key === 'j') s.scroll += 1
  else if (key === 'up' || key === 'k') s.scroll = Math.max(0, s.scroll - 1)
  else if (key === 'pagedown' || key === ' ' || key === 'space') s.scroll += page
  else if (key === 'pageup') s.scroll = Math.max(0, s.scroll - page)
  else if (key === 'home' || key === 'g') s.scroll = 0
  else if (key === 'end' || key === 'G') s.scroll = Number.MAX_SAFE_INTEGER
  else if (key === 'left' || key === 'h') s.hscroll = Math.max(0, s.hscroll - HSCROLL_STEP)
  else if (key === 'right' || key === 'l') s.hscroll += HSCROLL_STEP
  else if (key === 'n' || key === ']') jumpChange(true)
  else if (key === 'p' || key === '[') jumpChange(false)
  else if (key === 'J') stepFile(s, 1)
  else if (key === 'K') stepFile(s, -1)
  else if (key === 'e') {
    s.revealed.fill(1)
    s.revealedVersion += 1
  } else if (key === '/' && isCompact(s)) openPicker(s, 'files')
  else if (key === '/') {
    if (!s.props.options.showTree) s.actions.toggle('showTree')
    s.focus = 'search'
  } else if (key === 'O') s.actions.regroup()
  else if (key === 'x') {
    const path = currentPath(s)
    if (path !== undefined) s.actions.toggleViewed(path)
  }
  else if (key === 'q') s.actions.quit()
  else if (key === 'm') openPicker(s, 'mode')
  else if (key === 'V') openPicker(s, 'view')
  else if (key === 'b' && kind !== undefined) openPicker(s, kind)
  else if (byNumber !== undefined) chooseMode(s, byNumber)
  else {
    const item = viewItems(s).find(entry => entry.key === key)
    if (item !== undefined) perform(s, item.act, false)
  }
}
