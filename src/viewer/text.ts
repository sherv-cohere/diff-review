import type { KeyEvent as ClientKeyEvent } from '../surface'

export type Edit = { text: string; cursor: number }

const WORD = /[\p{L}\p{N}_]/u

function isWord(char: string | undefined): boolean {
  return char !== undefined && WORD.test(char)
}

function wordStart(text: string, from: number): number {
  let i = from
  while (i > 0 && !isWord(text[i - 1])) i--
  while (i > 0 && isWord(text[i - 1])) i--
  return i
}

function wordEnd(text: string, from: number): number {
  let i = from
  while (i < text.length && !isWord(text[i])) i++
  while (i < text.length && isWord(text[i])) i++
  return i
}

function lineStart(text: string, from: number): number {
  return text.lastIndexOf('\n', from - 1) + 1
}

function lineEnd(text: string, from: number): number {
  const end = text.indexOf('\n', from)
  return end < 0 ? text.length : end
}

// Terminals send Option+arrow as meta+arrow or meta+b/f, and most turn Cmd+arrow
// into Home/End or Ctrl+A/E and Cmd+Backspace into Ctrl+U; Cmd itself never arrives.

/** Where a cursor-moving key puts the cursor, or null for any other key. */
function moveTo(text: string, cursor: number, event: ClientKeyEvent): number | null {
  const { key } = event
  const byWord = event.meta === true || event.ctrl === true

  if (key === 'left') return byWord ? wordStart(text, cursor) : Math.max(0, cursor - 1)
  if (key === 'right') return byWord ? wordEnd(text, cursor) : Math.min(text.length, cursor + 1)
  if (event.meta === true && key === 'b') return wordStart(text, cursor)
  if (event.meta === true && key === 'f') return wordEnd(text, cursor)
  if (key === 'home' || (event.ctrl === true && key === 'a')) return lineStart(text, cursor)
  if (key === 'end' || (event.ctrl === true && key === 'e')) return lineEnd(text, cursor)
  return null
}

/** The [start, end) a deleting key removes, or null for any other key. */
function cutRange(text: string, cursor: number, event: ClientKeyEvent): [number, number] | null {
  const { key } = event
  const byWord = event.meta === true || event.ctrl === true

  if (key === 'backspace') return byWord ? [wordStart(text, cursor), cursor] : [Math.max(0, cursor - 1), cursor]
  if (key === 'delete') return byWord ? [cursor, wordEnd(text, cursor)] : [cursor, Math.min(text.length, cursor + 1)]
  if (event.ctrl === true && key === 'w') return [wordStart(text, cursor), cursor]
  if (event.meta === true && key === 'd') return [cursor, wordEnd(text, cursor)]
  if (event.ctrl === true && key === 'u') return [lineStart(text, cursor), cursor]
  if (event.ctrl === true && key === 'k') return [cursor, lineEnd(text, cursor)]
  return null
}

/** The text and cursor after a key that moves or deletes, or null when the key does neither. */
export function editText(text: string, cursor: number, event: ClientKeyEvent): Edit | null {
  const moved = moveTo(text, cursor, event)
  if (moved !== null) return { text, cursor: moved }

  const cut = cutRange(text, cursor, event)
  if (cut === null) return null
  return { text: text.slice(0, cut[0]) + text.slice(cut[1]), cursor: cut[0] }
}
