import type { Change, FileEntry, Row, Segment, ViewerFile } from './types'
import { changeRanges } from './git'
import { visibleRows } from './viewer/model'

/** Where each row of an all-files view comes from: the file and its row in that file's whole diff. */
export type Place = { path: string; row: number }

export type AllFiles = { file: ViewerFile; places: Place[] }

/**
 * Every file's changed hunks, with their context rows and commented rows, as
 * one run of rows the viewer scrolls through; `files` in the order it lists them.
 */
export function combineFiles(key: string, files: FileEntry[], rowsOf: (path: string) => Row[], kept: (path: string) => [number, number][]): AllFiles {
  const rows: Row[] = []
  const places: Place[] = []
  const segments: Segment[] = []
  const changes: Change[] = []

  for (const entry of files) {
    const { path } = entry
    const fileRows = entry.isBinary ? [] : rowsOf(path)
    const revealed = new Uint8Array(fileRows.length)
    for (const [start, end] of kept(path)) revealed.fill(1, start, end + 1)

    const shown = visibleRows({ total: fileRows.length, changes: changeRanges(fileRows), revealed, notes: [] })
    const start = rows.length
    fileRows.forEach((row, index) => {
      if (shown[index] !== 1) return
      rows.push(row)
      places.push({ path, row: index })
    })

    for (const change of changeRanges(rows.slice(start))) changes.push({ start: change.start + start, end: change.end + start, removed: change.removed })
    segments.push({ ...entry, start, end: rows.length })
  }

  const file: ViewerFile = {
    key: `${key}:${rows.length}`,
    path: '',
    status: 'M',
    isBinary: false,
    changes,
    rows,
    segments,
  }

  return { file, places }
}
