import type { FileEntry, FileGroup } from '../types'

/** A grouped tree's file names its folder in `dir`, since its rows are not under folders. */
export type TreeRow =
  | { kind: 'dir'; depth: number; name: string; path: string; isOpen: boolean }
  | { kind: 'group'; depth: number; name: string; path: string; isOpen: boolean; count: number }
  | { kind: 'file'; depth: number; name: string; entry: FileEntry; dir?: string }

type Dir = { dirs: Map<string, Dir>; files: FileEntry[] }

/**
 * The file tree as visible rows: directories first, single-child directory chains
 * joined (`cmd/ax`), and, while filtering, only matching files with their folders open.
 */
/** Whether text holds every space-separated term of a filter, ignoring case. */
export function matcher(filter: string): (text: string) => boolean {
  const terms = filter.toLowerCase().split(/\s+/).filter(Boolean)
  return text => terms.every(term => text.toLowerCase().includes(term))
}

export function buildTree(files: FileEntry[], filter: string, closed: ReadonlySet<string>): TreeRow[] {
  const isFiltering = filter.trim() !== ''
  const matches = matcher(filter)

  const root: Dir = { dirs: new Map(), files: [] }
  for (const entry of files) {
    if (!matches(entry.path)) continue
    const parts = entry.path.split('/')
    let dir = root
    for (const part of parts.slice(0, -1)) {
      const child = dir.dirs.get(part) ?? { dirs: new Map(), files: [] }
      dir.dirs.set(part, child)
      dir = child
    }
    dir.files.push(entry)
  }

  const rows: TreeRow[] = []
  const walk = (dir: Dir, depth: number, prefix: string) => {
    for (const [first, start] of [...dir.dirs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      let name = first
      let child = start
      while (child.files.length === 0 && child.dirs.size === 1) {
        const [nextName, nextDir] = [...child.dirs.entries()][0] as [string, Dir]
        name = `${name}/${nextName}`
        child = nextDir
      }

      const path = `${prefix}${name}`
      const isOpen = isFiltering || !closed.has(path)
      rows.push({ kind: 'dir', depth, name, path, isOpen })
      if (isOpen) walk(child, depth + 1, `${path}/`)
    }

    for (const entry of dir.files) {
      rows.push({ kind: 'file', depth, name: entry.path.split('/').pop() ?? entry.path, entry })
    }
  }
  walk(root, 0, '')

  return rows
}

/** The files under their groups, in the groups' order; a group's `path` keys whether it is closed. */
export function buildGroupedTree(files: FileEntry[], groups: FileGroup[], filter: string, closed: ReadonlySet<string>): TreeRow[] {
  const isFiltering = filter.trim() !== ''
  const matches = matcher(filter)
  const byPath = new Map(files.map(entry => [entry.path, entry]))

  return groups.flatMap((group, i): TreeRow[] => {
    const entries = group.paths.flatMap(path => {
      const entry = byPath.get(path)
      return entry !== undefined && matches(path) ? [entry] : []
    })
    if (entries.length === 0) return []

    const path = `group:${i}`
    const isOpen = isFiltering || !closed.has(path)
    const header: TreeRow = { kind: 'group', depth: 0, name: group.title, path, isOpen, count: entries.length }
    const rows = entries.map((entry): TreeRow => {
      const slash = entry.path.lastIndexOf('/')
      return { kind: 'file', depth: 1, name: entry.path.slice(slash + 1), entry, dir: entry.path.slice(0, Math.max(0, slash)) }
    })

    return isOpen ? [header, ...rows] : [header]
  })
}
