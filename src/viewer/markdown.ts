import { type Cls, type MermaidArt, render as renderMermaid } from 'grok-mermaid'
import { Lexer, type MarkedToken, type Token, type Tokens } from 'marked'
import { languageFor, type ThemedToken, tokenize } from './highlight'
import { C } from './palette'

type Style = { fg?: string; bg?: string; bold?: boolean; italic?: boolean }
export type Span = Style & { t: string }

/**
 * One drawn row and the source lines it came from, `from` to `to`, 0-based. A `slides` row
 * (code, a diagram) keeps its width and scrolls sideways instead of wrapping.
 */
export type MdLine = { spans: Span[]; from: number; to: number; slides?: true }

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }

/** Markdown laid out as rows of at most `width` cells, but for code and diagrams, which slide. */
export function renderMarkdown(text: string, width: number): MdLine[] {
  return blocks(Lexer.lex(text), Math.max(10, width), true, 0)
}

// --- blocks ------------------------------------------------------------------------

function blocks(tokens: Token[], width: number, isSpaced: boolean, firstLine: number): MdLine[] {
  const out: MdLine[] = []
  let line = firstLine
  for (const token of tokens) {
    const lines = block(token as MarkedToken, width, line)
    line += newlines(token.raw)
    if (lines.length === 0) continue
    if (isSpaced && out.length > 0) out.push(blank(lines[0] as MdLine))
    out.push(...lines)
  }

  return out
}

function block(token: MarkedToken, width: number, line: number): MdLine[] {
  const last = line + Math.max(0, newlines(token.raw.trimEnd()))
  const whole = (rows: Span[][]) => rows.map((spans): MdLine => ({ spans, from: line, to: last }))

  switch (token.type) {
    case 'heading':
      return whole(wrap(inline(token.tokens, { bold: true, fg: token.depth <= 2 ? C.accent : C.fg }), width))
    case 'paragraph':
      return whole(wrap(inline(token.tokens), width))
    case 'text':
      return whole(wrap(token.tokens === undefined ? [{ t: decode(token.text) }] : inline(token.tokens), width))
    case 'code': {
      const firstCode = token.codeBlockStyle === 'indented' ? line : line + 1
      const drawn = token.lang === 'mermaid' ? diagram(token.text, width) : null
      if (drawn !== null) {
        const art = drawn.art.map((spans): MdLine => ({ spans, from: line, to: last, slides: true }))
        return [...art, ...whole(drawn.notes.flatMap(note => wrap(note, width)))]
      }
      return code(token.text, token.lang, width).map((spans, i): MdLine => ({ spans, from: firstCode + i, to: firstCode + i, slides: true }))
    }
    case 'table':
      return table(token, width, line)
    case 'list':
      return list(token, width, line)
    case 'blockquote': {
      const bar: Span[] = [{ t: '│ ', fg: C.border }]
      return indent(blocks(token.tokens, width - 2, true, line), bar, bar)
    }
    case 'hr':
      return whole([[{ t: '─'.repeat(width), fg: C.border }]])
    case 'html':
      return token.text.trim() === '' ? [] : whole(wrap([{ t: token.text.trim(), fg: C.faint }], width))
    default:
      return []
  }
}

function newlines(text: string): number {
  return text.split('\n').length - 1
}

/** An empty row standing between blocks, belonging to the block after it. */
function blank(next: MdLine): MdLine {
  return { spans: [], from: next.from, to: next.from }
}

function code(source: string, lang: string | undefined, width: number): Span[][] {
  // Rows are measured in characters, so tabs become the diff view's four columns.
  const text = source.replaceAll('\t', '    ')
  const name = lang === undefined || lang === '' ? undefined : (languageFor(`x.${lang}`) ?? lang)
  const lines = text.split('\n')
  const tokens: ThemedToken[][] = tokenize(lines, name) ?? lines.map(content => [{ content, offset: 0 }])

  const rows = tokens.map((line): Span[] => [{ t: '  ', bg: C.bar }, ...line.map(token => ({ t: token.content, fg: token.color ?? C.fg, bg: C.bar }))])
  // Padded to the widest row, so the background still reaches the edge once the block slides.
  const fill = Math.max(width, ...rows.map(spanWidth))
  return rows.map(row => [...row, { t: ' '.repeat(fill - spanWidth(row)), bg: C.bar }])
}

const DIAGRAM_COLORS: Record<Cls, string> = {
  border: C.faint,
  text: C.fg,
  edge: C.accent,
  edgeLabel: C.dim,
  none: C.fg,
}

/**
 * A mermaid block drawn as box-drawing text, followed by what the drawing could not hold: edge
 * labels with no room, and statements the parser dropped, which a reviewer would otherwise take
 * for a diagram that never had them. Null for a diagram the renderer cannot draw.
 */
function diagram(source: string, width: number): { art: Span[][]; notes: Span[][] } | null {
  const drawing = fittedDiagram(source, width)
  if (drawing === null) return null

  const rows = drawing.styled.map(row => row.map((span): Span => ({ t: span.text, fg: DIAGRAM_COLORS[span.cls] })))
  const legend = drawing.legend.map((label): Span[] => [{ t: label, fg: C.dim }])
  const dropped = drawing.warnings.map((warning): Span[] => [{ t: `! ${warning}`, fg: C.yellow }])
  return { art: rows, notes: [...legend, ...dropped] }
}

function fittedDiagram(source: string, width: number): MermaidArt | null {
  const written = renderMermaid(source)
  if (written === null || written.width <= width) return written

  const compact = renderMermaid(source, { compact: true })
  return compact !== null && compact.width < written.width ? compact : written
}

function list(token: Tokens.List, width: number, firstLine: number): MdLine[] {
  const out: MdLine[] = []
  const first = typeof token.start === 'number' ? token.start : 1
  const markers = token.items.map((item, i) => (item.task ? (item.checked === true ? '☑ ' : '☐ ') : token.ordered ? `${first + i}. ` : '• '))
  const markerWidth = Math.max(...markers.map(marker => marker.length))
  let line = firstLine

  token.items.forEach((item, i) => {
    const marker = (markers[i] ?? '').padEnd(markerWidth)
    const body = blocks(item.tokens, width - markerWidth, item.loose, line)
    if (token.loose && i > 0 && body[0] !== undefined) out.push(blank(body[0]))
    out.push(...indent(body, [{ t: marker, fg: C.dim }], [{ t: ' '.repeat(markerWidth) }], line))
    line += newlines(item.raw)
  })

  return out
}

function indent(lines: MdLine[], first: Span[], rest: Span[], line = lines[0]?.from ?? 0): MdLine[] {
  if (lines.length === 0) return [{ spans: first, from: line, to: line }]
  return lines.map((one, i) => ({ ...one, spans: [...(i === 0 ? first : rest), ...one.spans] }))
}

// --- tables ------------------------------------------------------------------------

function table(token: Tokens.Table, width: number, line: number): MdLine[] {
  const rows = [token.header, ...token.rows].map(row => row.map(cell => inline(cell.tokens, cell.header ? { bold: true } : {})))
  const natural = token.header.map((_, col) => Math.max(1, ...rows.map(row => spanWidth(row[col] ?? []))))
  const longestWord = token.header.map((_, col) => Math.max(1, ...rows.map(row => longestWordIn(row[col] ?? []))))
  // Each column takes its text plus a space either side and one border.
  const widths = fitColumns(natural, longestWord, width - (3 * natural.length + 1))

  const cells = rows.map(row => widths.map((w, col) => wrap(row[col] ?? [], w)))
  const isWrapped = cells.some(row => row.some(lines => lines.length > 1))
  // The header is the table's first source line, the delimiter its second, and each body row one more.
  const sourceOf = (r: number) => (r === 0 ? line : line + 1 + r)
  const rule = (left: string, mid: string, right: string, at: number): MdLine => ({
    spans: [{ t: left + widths.map(w => '─'.repeat(w + 2)).join(mid) + right, fg: C.border }],
    from: at,
    to: at,
  })

  const out: MdLine[] = [rule('┌', '┬', '┐', line)]
  cells.forEach((row, r) => {
    if (r === 1 || (r > 1 && isWrapped)) out.push(rule('├', '┼', '┤', sourceOf(r)))
    const height = Math.max(...row.map(lines => lines.length))
    for (let k = 0; k < height; k++) {
      const spans: Span[] = [{ t: '│', fg: C.border }]
      row.forEach((lines, col) => {
        spans.push({ t: ' ' }, ...aligned(lines[k] ?? [], widths[col] ?? 1, token.align[col] ?? null), { t: ' ' }, { t: '│', fg: C.border })
      })
      out.push({ spans, from: sourceOf(r), to: sourceOf(r) })
    }
  })
  out.push(rule('└', '┴', '┘', sourceOf(cells.length - 1)))

  return out
}

/**
 * Column widths summing to at most `room`. Each column first gets its longest word, so words stay
 * whole where they can, and the rest is shared by how much more text each column holds.
 */
function fitColumns(natural: number[], longestWord: number[], room: number): number[] {
  const total = sum(natural)
  if (total <= room) return natural

  const floor = natural.map((w, col) => Math.min(w, longestWord[col] ?? 1))
  const floorTotal = sum(floor)
  if (floorTotal >= room) return floor.map(w => Math.max(1, Math.floor((w * room) / floorTotal)))

  const extra = room - floorTotal
  return floor.map((w, col) => w + Math.floor((extra * ((natural[col] ?? w) - w)) / (total - floorTotal)))
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function longestWordIn(spans: Span[]): number {
  return Math.max(0, ...spans.flatMap(span => span.t.split(/\s+/)).map(word => word.length))
}

function aligned(line: Span[], width: number, align: Tokens.TableCell['align']): Span[] {
  const gap = Math.max(0, width - spanWidth(line))
  const before = align === 'right' ? gap : align === 'center' ? Math.floor(gap / 2) : 0
  return [{ t: ' '.repeat(before) }, ...line, { t: ' '.repeat(gap - before) }]
}

// --- inline ------------------------------------------------------------------------

function inline(tokens: Token[] | undefined, style: Style = {}): Span[] {
  return (tokens ?? []).flatMap(token => inlineSpans(token as MarkedToken, style))
}

function inlineSpans(token: MarkedToken, style: Style): Span[] {
  switch (token.type) {
    case 'text':
      return token.tokens === undefined ? [{ ...style, t: decode(token.text).replaceAll('\n', ' ') }] : inline(token.tokens, style)
    case 'escape':
      return [{ ...style, t: token.text }]
    case 'strong':
      return inline(token.tokens, { ...style, bold: true })
    case 'em':
      return inline(token.tokens, { ...style, italic: true })
    case 'del':
      return inline(token.tokens, { ...style, fg: C.faint })
    case 'codespan':
      return [{ ...style, t: decode(token.text), fg: C.code, bg: C.button }]
    case 'link':
      return inline(token.tokens, { ...style, fg: C.accent })
    case 'image':
      return [{ ...style, t: `[${token.text}]`, fg: C.dim }]
    case 'br':
      return [{ t: '\n' }]
    default:
      return []
  }
}

function decode(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, name: string) => ENTITIES[name] ?? '')
}

export function spanWidth(spans: Span[]): number {
  return sum(spans.map(span => span.t.length))
}

/** Word-wraps styled text at `width`, breaking at spaces and `\n` and cutting words longer than a line. */
function wrap(spans: Span[], maxWidth: number): Span[][] {
  // Nested lists and quotes in a narrow pane can leave no room at all.
  const width = Math.max(1, maxWidth)
  const lines: Span[][] = [[]]
  let used = 0

  const put = ({ t, ...style }: Span) => {
    const line = lines[lines.length - 1] as Span[]
    const last = line[line.length - 1]
    const isSameStyle = last !== undefined && last.fg === style.fg && last.bg === style.bg && last.bold === style.bold && last.italic === style.italic
    if (isSameStyle) last.t += t
    else line.push({ ...style, t })
    used += t.length
  }
  const breakLine = () => {
    lines.push([])
    used = 0
  }

  // A word may run across spans, as `(` before inline code does, and breaks only where a space is.
  for (const piece of words(spans)) {
    if (piece === '\n') breakLine()
    else if (piece === ' ') {
      if (used > 0 && used < width) put({ t: ' ' })
    } else {
      if (used > 0 && used + spanWidth(piece) > width) breakLine()
      for (const part of piece) {
        let rest = part.t
        while (used + rest.length > width) {
          put({ ...part, t: rest.slice(0, width - used) })
          breakLine()
          rest = rest.slice(width - used)
        }
        if (rest.length > 0) put({ ...part, t: rest })
      }
    }
  }

  return lines
}

/** The text as words (each the styled spans it runs across), single spaces and line breaks. */
function words(spans: Span[]): (Span[] | ' ' | '\n')[] {
  const out: (Span[] | ' ' | '\n')[] = []
  for (const { t, ...style } of spans) {
    for (const piece of t.split(/(\n| +)/)) {
      const last = out[out.length - 1]
      if (piece === '') continue
      else if (piece === '\n') out.push('\n')
      else if (piece.startsWith(' ')) out.push(' ')
      else if (Array.isArray(last)) last.push({ ...style, t: piece })
      else out.push([{ ...style, t: piece }])
    }
  }

  return out
}
