import type { KeyEvent, Line, PointerEvent, Seg, WheelAxis } from './surface'

const ESC = '\x1b'
const CSI = `${ESC}[`

// Alternate screen, hidden cursor, button and drag mouse reports in SGR form, bracketed
// paste, and the kitty keyboard's disambiguation, which tells Shift+Enter from Enter.
const ENTER = `${CSI}?1049h${CSI}?25l${CSI}?1002h${CSI}?1006h${CSI}?2004h${CSI}>1u`
const LEAVE = `${CSI}<u${CSI}?2004l${CSI}?1006l${CSI}?1002l${CSI}?25h${CSI}?1049l`

const SYNC_START = `${CSI}?2026h`
const SYNC_END = `${CSI}?2026l`

export type Input =
  | { kind: 'key'; event: KeyEvent }
  | { kind: 'pointer'; event: PointerEvent }
  | { kind: 'wheel'; axis: WheelAxis; by: number; x: number; y: number }

// --- output ---------------------------------------------------------------------------

function rgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1, 7), 16)
  return `${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`
}

function sgr(seg: Seg): string {
  const codes = ['0']
  if (seg.bold === true) codes.push('1')
  if (seg.italic === true) codes.push('3')
  if (seg.fg !== undefined) codes.push(`38;2;${rgb(seg.fg)}`)
  if (seg.bg !== undefined) codes.push(`48;2;${rgb(seg.bg)}`)
  return `${CSI}${codes.join(';')}m`
}

function encode(line: Line): string {
  // Erased first because a full row leaves the cursor on its last column, where erasing would take the final character.
  let out = `${CSI}0m${CSI}K`
  for (const seg of line.segs) out += sgr(seg) + seg.t
  return `${out}${CSI}0m`
}

/** Paints frames, rewriting only the rows that changed since the last one. */
export class Screen {
  private painted: string[] = []

  enter(): void {
    process.stdout.write(ENTER)
  }

  leave(): void {
    process.stdout.write(`${CSI}0m${LEAVE}`)
  }

  /** Forgets what is on screen, so the next frame paints every row. */
  invalidate(): void {
    this.painted = []
  }

  paint(lines: Line[], rows: number): void {
    let out = ''
    const next: string[] = []
    for (let y = 0; y < rows; y++) {
      const line = lines[y]
      const encoded = line === undefined ? `${CSI}0m${CSI}K` : encode(line)
      next.push(encoded)
      if (this.painted[y] !== encoded) out += `${CSI}${y + 1};1H${encoded}`
    }
    this.painted = next

    if (out !== '') process.stdout.write(SYNC_START + out + SYNC_END)
  }
}

// --- input ------------------------------------------------------------------------------

const CSI_KEYS: Record<string, string> = {
  A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', Z: 'tab',
  '1~': 'home', '7~': 'home', '4~': 'end', '8~': 'end', '2~': 'insert', '3~': 'delete', '5~': 'pageup', '6~': 'pagedown',
}

// Kitty keyboard codepoints for keys that have a name rather than a character.
const KITTY_KEYS: Record<number, string> = { 9: 'tab', 13: 'return', 27: 'escape', 127: 'backspace', 32: 'space' }

function withModifiers(key: string, mask: number): KeyEvent {
  const event: KeyEvent = { key }
  if (mask & 1) event.shift = true
  if (mask & 2) event.meta = true
  if (mask & 4) event.ctrl = true
  return event
}

function controlKey(code: number): KeyEvent | null {
  if (code === 13) return { key: 'return' }
  // Ctrl+J: the newline a terminal without the kitty keyboard can send in place of Shift+Enter.
  if (code === 10) return { key: 'return', shift: true }
  if (code === 9) return { key: 'tab' }
  if (code === 127) return { key: 'backspace' }
  if (code === 8) return { key: 'backspace', ctrl: true }
  if (code >= 1 && code <= 26) return { key: String.fromCharCode(code + 96), ctrl: true }
  return null
}

function mouse(params: string, isRelease: boolean): Input | null {
  const [code = 0, column = 1, row = 1] = params.split(';').map(Number)
  const x = column - 1
  const y = row - 1

  if (code & 64) {
    // Buttons 66 and 67 are a trackpad's sideways swipe; Shift turns a mouse wheel sideways, as in most apps.
    const isSideways = (code & 2) !== 0 || (code & 4) !== 0
    return { kind: 'wheel', axis: isSideways ? 'horizontal' : 'vertical', by: code & 1 ? 1 : -1, x, y }
  }

  const buttons = ['left', 'middle', 'right'] as const
  const button = buttons[code & 3]
  const type = isRelease ? 'up' : code & 32 ? 'move' : 'down'
  const event: PointerEvent = { type, x, y }
  if (button !== undefined) event.button = button
  if (code & 4) event.shift = true
  if (code & 8) event.alt = true
  if (code & 16) event.ctrl = true
  return { kind: 'pointer', event }
}

const PASTE_START = `${CSI}200~`
const PASTE_END = `${CSI}201~`

/** Splits raw terminal input into keys, mouse events and pastes; keeps an unfinished sequence for the next chunk. */
export class InputParser {
  private pending = ''

  feed(chunk: string): Input[] {
    let data = this.pending + chunk
    this.pending = ''
    const out: Input[] = []

    while (data.length > 0) {
      if (data.startsWith(PASTE_START)) {
        const end = data.indexOf(PASTE_END)
        if (end < 0) {
          this.pending = data
          break
        }
        out.push({ kind: 'key', event: { key: data.slice(PASTE_START.length, end) } })
        data = data.slice(end + PASTE_END.length)
        continue
      }

      const csi = /^\x1b\[([<?>]?)([\d;:]*)([A-Za-z~])/.exec(data)
      if (csi !== null) {
        const [whole, prefix = '', params = '', final = ''] = csi
        data = data.slice(whole.length)
        const input = this.csi(prefix, params, final)
        if (input !== null) out.push(input)
        continue
      }

      const ss3 = /^\x1bO([A-DHF])/.exec(data)
      if (ss3 !== null) {
        data = data.slice(ss3[0].length)
        out.push({ kind: 'key', event: { key: CSI_KEYS[ss3[1] ?? ''] ?? '' } })
        continue
      }

      if (data === ESC) {
        out.push({ kind: 'key', event: { key: 'escape' } })
        break
      }
      if (data.startsWith(CSI) || data.startsWith(`${ESC}O`)) {
        // An escape sequence cut across two reads.
        if (data.length < 32) this.pending = data
        break
      }

      if (data.startsWith(ESC)) {
        const next = data.codePointAt(1) ?? 0
        const char = String.fromCodePoint(next)
        data = data.slice(1 + char.length)
        const event = controlKey(next) ?? { key: char }
        out.push({ kind: 'key', event: { ...event, meta: true } })
        continue
      }

      const code = data.codePointAt(0) ?? 0
      const char = String.fromCodePoint(code)
      data = data.slice(char.length)
      out.push({ kind: 'key', event: controlKey(code) ?? { key: char === ' ' ? 'space' : char } })
    }

    return out
  }

  private csi(prefix: string, params: string, final: string): Input | null {
    if (prefix === '<' && (final === 'M' || final === 'm')) return mouse(params, final === 'm')
    if (prefix !== '') return null

    const [first = '', modifier = '1'] = params.split(';')
    const mask = Number(modifier.split(':')[0]) - 1

    if (final === 'u') {
      const code = Number(first.split(':')[0])
      const key = KITTY_KEYS[code] ?? String.fromCodePoint(code)
      return { kind: 'key', event: withModifiers(key, mask) }
    }

    const name = CSI_KEYS[final === '~' ? `${first}~` : final]
    if (name === undefined) return null
    const event = withModifiers(name, final === 'Z' ? mask | 1 : mask)
    return { kind: 'key', event }
  }
}
