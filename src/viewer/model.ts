import type { Change, Layout, Row, Segment, Side } from '../types'

export const CONTEXT = 3

/**
 * One visual row of the diff body. A wrapped row's `part` counts its
 * continuation rows from 0; `file`, `fold` and `group` belong to the all-files
 * view, a group's `part` 0 its title and 1 its reason, `seg` its first file.
 */
export type Item =
  | { k: 'line'; row: number; part: number }
  | { k: 'pair'; left: number; right: number; part: number }
  | { k: 'gap'; from: number; to: number }
  | { k: 'note'; id: number; part: number }
  | { k: 'file'; seg: number }
  | { k: 'fold'; seg: number; count: number }
  | { k: 'group'; group: number; seg: number; part: number }
  | { k: 'end' }

/** A box drawn under a row: a saved comment (id >= 0) or the open composer (id -1). */
export type Note = { id: number; side: Side; endRow: number; height: number }

export type ItemsInput = {
  total: number
  changes: Change[]
  revealed: Uint8Array
  /** How the row at an index draws: a new or deleted file has one side, so it draws unified. */
  layoutAt: (row: number) => Layout
  notes: Note[]
}

/** Rows shown without expanding: the changes, CONTEXT rows around each, revealed rows and noted rows. */
export function visibleRows({ total, changes, revealed, notes }: Omit<ItemsInput, 'layoutAt'>): Uint8Array {
  const shown = new Uint8Array(total)
  for (const { start, end } of changes) {
    shown.fill(1, Math.max(0, start - CONTEXT), Math.min(total, end + CONTEXT))
  }
  for (let i = 0; i < total; i++) {
    if (revealed[i] === 1) shown[i] = 1
  }
  for (const note of notes) {
    if (note.endRow >= 0 && note.endRow < total) shown[note.endRow] = 1
  }

  // A fold of a single row costs as much room as the row itself.
  for (let i = 0; i < total; i++) {
    const isLoneHidden = shown[i] === 0 && (i === 0 || shown[i - 1] === 1) && (i === total - 1 || shown[i + 1] === 1)
    if (isLoneHidden) shown[i] = 1
  }

  return shown
}

export function buildItems(input: ItemsInput): Item[] {
  const { total, changes, layoutAt, notes } = input
  const shown = visibleRows(input)
  const items: Item[] = []

  const notesAfter = new Map<string, Note[]>()
  for (const note of notes) {
    const key = `${note.side}:${note.endRow}`
    notesAfter.set(key, [...(notesAfter.get(key) ?? []), note])
  }
  const pushNotes = (side: Side | 'both', row: number) => {
    const sides: Side[] = side === 'both' ? ['old', 'new'] : [side]
    for (const one of sides) {
      for (const note of notesAfter.get(`${one}:${row}`) ?? []) {
        for (let part = 0; part < note.height; part++) items.push({ k: 'note', id: note.id, part })
      }
    }
  }

  const changeAt = new Map<number, Change>(changes.map(change => [change.start, change]))

  let row = 0
  while (row < total) {
    if (shown[row] === 0) {
      const from = row
      while (row < total && shown[row] === 0) row++
      items.push({ k: 'gap', from, to: row })
      continue
    }

    const change = changeAt.get(row)
    const layout = layoutAt(row)
    if (change !== undefined && layout === 'split') {
      const { start, end, removed } = change
      const added = end - start - removed
      for (let i = 0; i < Math.max(removed, added); i++) {
        const left = i < removed ? start + i : -1
        const right = i < added ? start + removed + i : -1
        items.push({ k: 'pair', left, right, part: 0 })
        if (left >= 0) pushNotes('old', left)
        if (right >= 0) pushNotes('new', right)
      }
      row = end
      continue
    }

    if (layout === 'split') {
      items.push({ k: 'pair', left: row, right: row, part: 0 })
      pushNotes('both', row)
    } else {
      items.push({ k: 'line', row, part: 0 })
      pushNotes('both', row)
    }
    row++
  }

  items.push({ k: 'end' })
  return items
}

/** The first row an item draws, or -1 for items that draw none. */
export function itemRow(item: Item): number {
  if (item.k === 'line') return item.row
  if (item.k === 'pair') return item.left >= 0 ? item.left : item.right
  return -1
}

/**
 * Puts a header before each file's rows and a fold wherever its line numbers
 * jump, since the all-files view carries only the rows around changes.
 */
export function withFiles(items: Item[], segments: Segment[], rowAt: (index: number) => Row | undefined): Item[] {
  const out: Item[] = []
  let seg = -1
  let lastOld = 0
  let lastNew = 0

  const enterUpTo = (row: number) => {
    while (seg + 1 < segments.length && (segments[seg + 1] as Segment).start <= row) {
      seg++
      lastOld = 0
      lastNew = 0
      out.push({ k: 'file', seg })
    }
  }

  for (const item of items) {
    if (item.k === 'end') continue

    const first = itemRow(item)
    if (first >= 0) {
      enterUpTo(first)
      const oldNo = item.k === 'pair' ? (item.left >= 0 ? (rowAt(item.left)?.old ?? 0) : 0) : (rowAt(first)?.old ?? 0)
      const newNo = item.k === 'pair' ? (item.right >= 0 ? (rowAt(item.right)?.new ?? 0) : 0) : (rowAt(first)?.new ?? 0)
      const skipped = Math.max(oldNo > 0 ? oldNo - lastOld - 1 : 0, newNo > 0 ? newNo - lastNew - 1 : 0)
      if (skipped > 0) out.push({ k: 'fold', seg, count: skipped })
      if (oldNo > 0) lastOld = oldNo
      if (newNo > 0) lastNew = newNo
    }
    out.push(item)
  }

  enterUpTo(Number.MAX_SAFE_INTEGER)
  out.push({ k: 'end' })
  return out
}

/** Wraps text to `width` cells, keeping each piece's offset into the text so a cursor can be placed. */
export function wrapText(text: string, width: number): { start: number; text: string }[] {
  const pieces: { start: number; text: string }[] = []
  const room = Math.max(1, width)
  let offset = 0

  for (const line of text.split('\n')) {
    if (line.length === 0) pieces.push({ start: offset, text: '' })
    for (let at = 0; at < line.length; ) {
      let cut = Math.min(line.length, at + room)
      const space = line.lastIndexOf(' ', cut)
      if (cut < line.length && space > at) cut = space + 1
      pieces.push({ start: offset + at, text: line.slice(at, cut) })
      at = cut
    }
    offset += line.length + 1
  }

  return pieces
}

/** Puts a group's title and reason before the first file of each group. */
export function withGroups(items: Item[], segments: Segment[], groupOf: (path: string) => number): Item[] {
  let last = -1

  return items.flatMap((item): Item[] => {
    if (item.k !== 'file') return [item]
    const group = groupOf(segments[item.seg]?.path ?? '')
    if (group === last) return [item]

    last = group
    return [{ k: 'group', group, seg: item.seg, part: 0 }, { k: 'group', group, seg: item.seg, part: 1 }, item]
  })
}
