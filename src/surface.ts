/** A key press: a special key's name (`up`, `return`, `pageup`, `escape`, …) or the character typed. */
export type KeyEvent = { key: string; ctrl?: true; shift?: true; meta?: true }

/** A mouse event in screen cells, 0-based from the top left. While a button is held, moves keep arriving past the edges. */
export type PointerEvent = {
  type: 'down' | 'move' | 'up'
  x: number
  y: number
  button?: 'left' | 'middle' | 'right'
  shift?: true
  alt?: true
  ctrl?: true
}

export type WheelAxis = 'vertical' | 'horizontal'

/** What the viewer needs from the screen it draws on. */
export type Surface = {
  readonly columns: number
  readonly rows: number
  /** Schedules another draw; several calls before it coalesce into one. */
  redraw(): void
}

export type Style = { fg?: string; bg?: string; bold?: boolean; italic?: boolean }
export type Seg = Style & { t: string }

/** One drawn row: styled segments that never exceed `width` cells. */
export class Line {
  readonly segs: Seg[] = []
  used = 0
  readonly width: number

  constructor(width: number) {
    this.width = width
  }

  get room(): number {
    return this.width - this.used
  }

  add(text: string, style: Style = {}): [number, number] {
    const start = this.used
    const t = text.slice(0, Math.max(0, this.room))
    if (t.length > 0) {
      const last = this.segs[this.segs.length - 1]
      const isSameStyle =
        last !== undefined && last.fg === style.fg && last.bg === style.bg && last.bold === style.bold && last.italic === style.italic
      if (isSameStyle) last.t += t
      else this.segs.push({ ...style, t })
      this.used += t.length
    }

    return [start, this.used]
  }

  fill(style: Style = {}, upTo = this.width): void {
    if (upTo > this.used) this.add(' '.repeat(upTo - this.used), style)
  }

  append(other: Line): void {
    for (const seg of other.segs) this.add(seg.t, seg)
  }
}
