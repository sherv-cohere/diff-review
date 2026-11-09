import { stripControls } from './labels.ts'
import { type CanvasResult, layoutClass, layoutFlowchart, layoutGrouped } from './layout.ts'
import { layoutSequence } from './layout-seq.ts'
import { diagramKind, parseClass, parseEr, parseGraph, parseSequence, parseState } from './parse.ts'
import type { Graph } from './graph.ts'
import type { MermaidArt, RenderOptions } from './types.ts'

export type { Cls, MermaidArt, Span } from './types.ts'

/**
 * Render a Mermaid source block as Unicode box-drawing art.
 *
 * Supported: `graph`/`flowchart` (including `subgraph`), `stateDiagram`,
 * `classDiagram`, `erDiagram` and `sequenceDiagram`.
 *
 * The diagram is laid out at whatever size it needs; `art.width` reports the
 * columns that turned out to be. Deciding what to do when that exceeds the
 * space at hand is the caller's.
 *
 * `null` means there is no art to show: blank input, a syntax error, a diagram
 * type this renderer does not draw, or one large enough that laying it out is
 * refused.
 *
 * Rendering is best-effort. A flowchart keeps whatever parsed; the stricter
 * grammars additionally get one retry without their final line, which is what
 * keeps a streaming diagram on screen while its last statement is half-typed.
 * Everything given up on is listed in `art.warnings` — advisory only, never a
 * reason to withhold the art.
 */
export function render(src: string, options: RenderOptions = {}): MermaidArt | null {
  src = stripControls(src)
  if (src.trim() === '') return null
  const drawn = attempt(src, options.compact === true)
  if (drawn === null) return null
  return { ...drawn.canvas.toLines(), warnings: drawn.warnings, legend: drawn.canvas.legend }
}

type Drawn = { canvas: NonNullable<CanvasResult>; warnings: string[] }

/**
 * Draw `src`, retrying once without its last line if the grammar rejects it.
 *
 * State, class, ER and sequence fail a whole diagram on one unreadable
 * statement, and while a source is streaming its last line is usually still
 * being typed — so without this a diagram alternates with the source box all
 * the way in. Only the final line is dropped, and doing so is always reported,
 * so a finished document with a bad last line still says what it lost rather
 * than quietly rendering short.
 */
function attempt(src: string, compact: boolean): Drawn | null {
  const drawn = draw(src, compact)
  if (drawn !== null) return drawn

  const body = src.replace(/\s+$/, '')
  const cut = body.lastIndexOf('\n')
  if (cut === -1) return null
  const salvaged = draw(body.slice(0, cut), compact)
  if (salvaged === null) return null

  const dropped = body.slice(cut + 1).trim()
  return {
    canvas: salvaged.canvas,
    warnings: [...salvaged.warnings, `dropped, unreadable final line: "${dropped}"`],
  }
}

function compactLayout(graph: Graph): void {
  graph.compact = true
  if (graph.dir === 'left' || graph.dir === 'right') graph.dir = 'down'
}

/** Dispatch on the declared diagram type; `null` means nothing was drawn. */
function draw(src: string, compact: boolean): Drawn | null {
  const plain = (canvas: CanvasResult) => (canvas === null ? null : { canvas, warnings: [] })

  switch (diagramKind(src)) {
    case 'flowchart': {
      const graph = parseGraph(src)
      if (graph === null) return null
      if (compact) compactLayout(graph)
      const canvas = graph.groups.length === 0 ? layoutFlowchart(graph) : layoutGrouped(graph)
      return canvas === null ? null : { canvas, warnings: graph.warnings }
    }
    case 'state': {
      const state = parseState(src)
      if (state !== null && compact) compactLayout(state)
      return state === null ? null : plain(layoutFlowchart(state))
    }
    case 'class': {
      const cls = parseClass(src)
      if (cls !== null && compact) compactLayout(cls.graph)
      return cls === null ? null : plain(layoutClass(cls.graph, cls.infos))
    }
    case 'er': {
      const er = parseEr(src)
      if (er !== null && compact) compactLayout(er.graph)
      return er === null ? null : plain(layoutClass(er.graph, er.infos))
    }
    case 'sequence': {
      const seq = parseSequence(src)
      return seq === null ? null : plain(layoutSequence(seq, compact))
    }
    default:
      return null
  }
}
