import { splitByFile } from './git'
import type { FileGroup, Listing } from './types'

// Diffs run about two characters a token for Haiku, so this keeps the whole prompt under 100k tokens.
const DIFF_BUDGET = 150_000
const TITLE_MAX = 60
// Keeps a long-winded reply from crowding the group headers in the file tree.
const WHY_MAX = 200

// Bodies a reviewer reads last and the model learns little from; their files are still listed.
const LOW_SIGNAL = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|go\.sum|Cargo\.lock|poetry\.lock|uv\.lock|bun\.lockb?)$|(^|\/)(vendor|node_modules|dist)\//

export const GROUPING_SYSTEM = `You help a reviewer read a code change in a sensible order.

Group the changed files so each group is a part of the change a reviewer would read together: the code that carries one idea, with its tests and the call sites that exist only for it. Order the groups the way the author would explain the change: contracts, schemas and types first, then core logic, then callers and UI, then tests that stand on their own, then config, docs, generated files and lockfiles. Order the files within a group the same way.

Reply with JSON only, shaped as {"groups":[{"title":"...","why":"...","files":[1,2]}]}. "title" names what the group changes in at most six words. "why" is one sentence on what these files do together. "files" holds numbers from the list. Put every file in exactly one group. Aim for three to eight groups; a file that stands apart may be a group of its own.`

const OTHER = 'Other changes'
const OTHER_WHY = 'Files the grouping left out.'

type ReplyGroup = { title: string; why: string; files: number[] }

/** The numbered file list and each file's hunks, cut to the budget. */
export function groupingPrompt(listing: Listing, diff: string, isDiffCut: boolean): string {
  const paths = listing.files.map(file => file.path)
  const bodies = fitBodies(splitDiff(diff, paths), DIFF_BUDGET)

  const list = listing.files.map(({ path, status, added, removed }, i) => {
    const renamed = listing.oldPaths[path] === undefined ? '' : ` (renamed from ${listing.oldPaths[path]})`
    return `${i + 1}. ${status} ${path} +${added} -${removed}${renamed}`
  })
  const sections = paths.map((path, i) => `### ${i + 1} ${path}\n${bodies.get(path) ?? '(diff not included)'}`)
  const cutNote = isDiffCut ? '\n\nThe diff was cut short; files without a diff are judged by their path alone.' : ''

  return `Changed files:\n${list.join('\n')}${cutNote}\n\nDiffs:\n${sections.join('\n\n')}`
}

/** Each listed file's hunks in a whole-range diff, by its path; binary files and low-signal ones have none. */
export function splitDiff(diff: string, paths: string[]): Map<string, string> {
  const bodies = new Map<string, string>()
  for (const [path, hunks] of splitByFile(diff, paths)) {
    if (hunks !== '' && !LOW_SIGNAL.test(path)) bodies.set(path, hunks)
  }

  return bodies
}

/** Bodies cut to share `budget`: short ones whole, the long ones an even split of what is left. */
function fitBodies(bodies: Map<string, string>, budget: number): Map<string, string> {
  const shortestFirst = [...bodies].sort(([, a], [, b]) => a.length - b.length)
  const fitted = new Map<string, string>()
  let left = budget

  shortestFirst.forEach(([path, body], i) => {
    const share = Math.floor(left / (shortestFirst.length - i))
    const kept = body.length <= share ? body : `${body.slice(0, share)}\n… (cut)`
    fitted.set(path, kept)
    left -= Math.min(body.length, share)
  })

  return fitted
}

/**
 * The groups Haiku replied with, every listed file in exactly one: numbers that name no file
 * are dropped, a file named twice stays in its first group, and files left out are added last.
 */
export function parseGroups(text: string, paths: string[]): FileGroup[] | null {
  let reply: unknown
  try {
    reply = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
  } catch {
    return null
  }

  const placed = new Set<string>()
  const groups: FileGroup[] = []
  for (const group of replyGroups(reply)) {
    const members: string[] = []
    for (const path of group.files.map(n => paths[n - 1])) {
      if (path === undefined || placed.has(path)) continue
      placed.add(path)
      members.push(path)
    }
    if (members.length > 0) groups.push({ title: group.title.slice(0, TITLE_MAX), why: group.why.slice(0, WHY_MAX), paths: members })
  }
  if (groups.length === 0) return null

  const unplaced = paths.filter(path => !placed.has(path))
  if (unplaced.length > 0) groups.push({ title: OTHER, why: OTHER_WHY, paths: unplaced })

  return groups
}

function replyGroups(reply: unknown): ReplyGroup[] {
  const groups = (reply as { groups?: unknown } | null)?.groups
  return Array.isArray(groups) ? groups.filter(isReplyGroup) : []
}

function isReplyGroup(value: unknown): value is ReplyGroup {
  const group = value as Partial<Record<keyof ReplyGroup, unknown>> | null
  return typeof group?.title === 'string' && typeof group.why === 'string' && Array.isArray(group.files) && group.files.every(n => Number.isInteger(n))
}

// --- cache -------------------------------------------------------------------------

/** A grouping Haiku made, by the trees it compared; `repo` keeps lookups by path inside one repository. */
export type CachedGrouping = { key: string; repo: string; groups: FileGroup[]; usedAt: number }

const CACHE_SIZE = 40

/**
 * The cached grouping to reuse for a range without asking Haiku: the same range's, or else the
 * one from the same repo sharing the most files, while at least half the files are shared and
 * under a quarter are new.
 */
export function closestGrouping(cache: CachedGrouping[], repo: string, key: string, paths: string[]): CachedGrouping | null {
  const exact = cache.find(entry => entry.key === key)
  if (exact !== undefined) return exact

  let best: CachedGrouping | null = null
  let bestShared = 0
  for (const entry of cache) {
    if (entry.repo !== repo) continue
    const known = new Set(entry.groups.flatMap(group => group.paths))
    const shared = paths.filter(path => known.has(path)).length
    if (shared > bestShared) [best, bestShared] = [entry, shared]
  }

  const added = paths.length - bestShared
  const isClose = bestShared * 2 >= paths.length && added <= Math.max(3, Math.floor(paths.length / 4))
  return isClose ? best : null
}

/**
 * Cached groups fitted to the files listed now: files no longer listed leave, groups left empty go,
 * and each new file joins the group holding most files from its folder, or else "Other changes".
 */
export function fitGroups(cached: FileGroup[], paths: string[]): FileGroup[] {
  const listed = new Set(paths)
  const groups = cached.map(group => ({ ...group, paths: group.paths.filter(path => listed.has(path)) }))
  const known = new Set(groups.flatMap(group => group.paths))
  const unplaced: string[] = []

  for (const path of paths.filter(one => !known.has(one))) {
    const dir = folderOf(path)
    const counts = groups.map(group => group.paths.filter(member => folderOf(member) === dir).length)
    const most = Math.max(0, ...counts)
    if (most === 0) unplaced.push(path)
    else groups[counts.indexOf(most)]?.paths.push(path)
  }

  const other = groups.find(group => group.title === OTHER)
  if (other !== undefined) other.paths.push(...unplaced)
  else if (unplaced.length > 0) groups.push({ title: OTHER, why: OTHER_WHY, paths: unplaced })

  return groups.filter(group => group.paths.length > 0)
}

/** The cache with `entry` in it, least recently used entries leaving past the size. */
export function remember(cache: CachedGrouping[], entry: CachedGrouping): CachedGrouping[] {
  return [entry, ...cache.filter(one => one.key !== entry.key)].sort((a, b) => b.usedAt - a.usedAt).slice(0, CACHE_SIZE)
}

function folderOf(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf('/')))
}
