import { diffWordsWithSpace } from 'diff'

export type Ranges = [number, number][]

const MAX_LINE = 1000

// Past this share of either line changed, word marks only add noise: the line is new.
const MAX_CHANGED_SHARE = 0.7

/**
 * The changed character ranges of a removed line and the added line paired with it,
 * or null when the lines differ too much for word marks to help. A one-character
 * unchanged gap between two changes joins them, as diffs.com's "word-alt" does.
 */
export function wordRanges(before: string, after: string): { old: Ranges; new: Ranges } | null {
  if (before.length > MAX_LINE || after.length > MAX_LINE) {
    return null
  }

  const old: Ranges = []
  const next: Ranges = []
  let oldAt = 0
  let newAt = 0

  const mark = (ranges: Ranges, start: number, end: number) => {
    const last = ranges[ranges.length - 1]
    if (last !== undefined && start - last[1] <= 1) last[1] = end
    else ranges.push([start, end])
  }

  for (const part of diffWordsWithSpace(before, after)) {
    const length = part.value.length
    if (part.removed) {
      mark(old, oldAt, oldAt + length)
      oldAt += length
    } else if (part.added) {
      mark(next, newAt, newAt + length)
      newAt += length
    } else {
      oldAt += length
      newAt += length
    }
  }

  const share = (ranges: Ranges, length: number) =>
    length === 0 ? 1 : ranges.reduce((sum, [start, end]) => sum + end - start, 0) / length
  const isTooDifferent = share(old, before.length) > MAX_CHANGED_SHARE && share(next, after.length) > MAX_CHANGED_SHARE

  return isTooDifferent ? null : { old, new: next }
}
