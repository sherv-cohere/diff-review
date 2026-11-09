/**
 * Graph layout: rank, order, place, route, draw.
 *
 * Follows the Sugiyama outline — assign ranks along the flow axis, reorder
 * within ranks to cut crossings, then relax positions on the cross axis so
 * chains stay straight. Edges between adjacent ranks share horizontal "bus"
 * rows; everything else is routed around the diagram through vertical "lanes".
 *
 * `BT` and `RL` reuse the `TD`/`LR` layouts and flip the finished canvas, so
 * text never ends up mirrored.
 */

import {
  Canvas,
  D,
  drawText,
  drawTextOverEdges,
  L,
  R,
  STY_DOT,
  STY_SOLID,
  STY_THICK,
  U,
} from './canvas.ts'
import type { ClassInfo, Edge, Head, Node, Shape } from './graph.ts'
import { Graph } from './graph.ts'
import { WRAP_WIDTH, wrapLabel } from './labels.ts'
import { stringWidth, widest } from './width.ts'

/** Cells of padding between a box border and its text. */
const PAD = 1
/** Minimum horizontal / vertical space between boxes. */
const GAP_X = 3
const GAP_Y = 2
/**
 * Columns reserved for an edge label. A wider label still draws wherever its
 * route has the room, and is listed under the diagram when it has none.
 */
const LABEL_ROOM = 40
/** Half-width kept clear beside a top-down arrow; both sides are reserved, so this costs double. */
const SIDE_LABEL_ROOM = 20
/** Blank cells kept either side of a label, so neighbouring text cannot run together. */
const LABEL_PAD = 1
/** The far end of a span that runs out to the lanes past every box. */
const FAR = 1 << 30
/** Refuse to allocate a canvas larger than this many cells. */
const MAX_CANVAS_CELLS = 1 << 21

/** A laid-out canvas, or `null` when the diagram is empty or over the cell cap. */
export type CanvasResult = Canvas | null

/** Saturating subtraction; Rust's `usize` arithmetic never goes negative. */
const sat = (a: number, b: number): number => Math.max(0, a - b)
const half = (n: number): number => Math.floor(n / 2)

export interface Placed {
  x: number
  y: number
  w: number
  h: number
  cx: number
  cy: number
  rank: number
}

/** Cross-axis room for a label of `w` columns beside a box or arrow, kept on both sides. */
const sideRoom = (w: number): number => (w === 0 ? 0 : 2 * (w + 3))

/** Per-node dimensions. `lay*` include room for self-edge loops and labels. */
interface NodeSizes {
  boxW: number[]
  boxH: number[]
  layW: number[]
  layH: number[]
  extraH: number[]
  selfLabelW: number[]
}

/** What to draw inside a node box. */
export type NodeExtra =
  | { kind: 'plain' }
  | { kind: 'frame'; sub: Canvas }
  | { kind: 'compartments'; sections: string[][] }

interface RoutePlan extends Bands {
  canvasW: number
  canvasH: number
  /** Coordinate just past each rank's boxes, where its bus rows begin. */
  bandEnd: number[]
  /** Coordinate of the first lane track. */
  laneBase: number
  edgeLane: number[]
}

/** A stretch of an edge's route, the places its label can sit. */
type Segment =
  | { axis: 'h'; y: number; x0: number; x1: number }
  | { axis: 'v'; x: number; y0: number; y1: number }

const hSegment = (y: number, a: number, b: number): Segment => ({
  axis: 'h',
  y,
  x0: Math.min(a, b),
  x1: Math.max(a, b),
})
const vSegment = (x: number, a: number, b: number): Segment => ({
  axis: 'v',
  x,
  y0: Math.min(a, b),
  y1: Math.max(a, b),
})

/**
 * Longest-path ranking over the graph's DAG.
 *
 * Back edges (those closing a cycle) are excluded by a DFS colouring pass, so
 * `A --> B --> C --> A` still ranks 0, 1, 2 rather than diverging.
 */
export function computeRanks(graph: Graph): number[] {
  const n = graph.nodes.length
  const children: number[][] = Array.from({ length: n }, () => [])
  const indeg = new Array<number>(n).fill(0)
  for (const e of graph.edges) {
    if (e.from !== e.to) {
      children[e.from].push(e.to)
      indeg[e.to]++
    }
  }

  const color = new Uint8Array(n)
  const dag: number[][] = Array.from({ length: n }, () => [])
  const order: number[] = []

  // Roots first so ranks grow from natural entry points, then any leftovers.
  const roots = [...Array(n).keys()].filter((i) => indeg[i] === 0)
  for (const start of [...roots, ...Array(n).keys()]) {
    if (color[start] === 0) dfsDag(start, children, color, dag, order)
  }

  const rank = new Array<number>(n).fill(0)
  for (let i = order.length - 1; i >= 0; i--) {
    const u = order[i]
    for (const v of dag[u]) rank[v] = Math.max(rank[v], rank[u] + 1)
  }
  return rank
}

/** Iterative DFS recording postorder and skipping edges back into the stack. */
function dfsDag(
  start: number,
  children: number[][],
  color: Uint8Array,
  dag: number[][],
  order: number[],
): void {
  const stack: { u: number; i: number }[] = [{ u: start, i: 0 }]
  color[start] = 1
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]
    const u = frame.u
    if (frame.i < children[u].length) {
      const v = children[u][frame.i]
      frame.i++
      if (color[v] === 1) continue // grey: a back edge, ignore it
      dag[u].push(v)
      if (color[v] === 0) {
        color[v] = 1
        stack.push({ u: v, i: 0 })
      }
    } else {
      color[u] = 2
      order.push(u)
      stack.pop()
    }
  }
}

/**
 * Reorder nodes within each rank to minimise edge crossings (barycenter
 * sweeps): alternate down/up passes sort each rank by the mean position of its
 * neighbours, keeping whichever ordering crossed least.
 */
export function orderRanks(byRank: number[][], edges: Edge[], ranks: number[]): void {
  const n = ranks.length
  if (byRank.length < 2 || n < 3) return

  const parents: number[][] = Array.from({ length: n }, () => [])
  const children: number[][] = Array.from({ length: n }, () => [])
  for (const e of edges) {
    if (e.from !== e.to && ranks[e.to] > ranks[e.from]) {
      parents[e.to].push(e.from)
      children[e.from].push(e.to)
    }
  }

  const pos = new Array<number>(n).fill(0)
  const reindex = (row: number[]): void => {
    for (let i = 0; i < row.length; i++) pos[row[i]] = i
  }
  for (const row of byRank) reindex(row)

  let best = byRank.map((row) => [...row])
  let bestCrossings = countCrossings(edges, ranks, pos)
  if (bestCrossings === 0) return

  for (let it = 0; it < 8; it++) {
    // Alternate sweeping down (sort by parents) and up (sort by children).
    const rows = it % 2 === 0 ? byRank.slice(1) : byRank.slice(0, -1).reverse()
    const neigh = it % 2 === 0 ? parents : children
    for (const row of rows) {
      sortByBarycenter(row, neigh, pos)
      reindex(row)
    }
    const crossings = countCrossings(edges, ranks, pos)
    if (crossings < bestCrossings) {
      bestCrossings = crossings
      best = byRank.map((row) => [...row])
    }
    if (bestCrossings === 0) break
  }

  for (let i = 0; i < byRank.length; i++) byRank[i].splice(0, byRank[i].length, ...best[i])
}

function sortByBarycenter(row: number[], neigh: number[][], pos: number[]): void {
  const keyed = row.map((v) => ({
    key:
      neigh[v].length === 0 ? pos[v] : neigh[v].reduce((s, u) => s + pos[u], 0) / neigh[v].length,
    v,
  }))
  keyed.sort((a, b) => a.key - b.key)
  for (let i = 0; i < keyed.length; i++) row[i] = keyed[i].v
}

export function countCrossings(edges: Edge[], ranks: number[], pos: number[]): number {
  const adjacent = edges
    .filter((e) => e.from !== e.to && ranks[e.to] === ranks[e.from] + 1)
    .map((e) => [ranks[e.from], pos[e.from], pos[e.to]] as const)
  let crossings = 0
  for (let i = 0; i < adjacent.length; i++) {
    const a = adjacent[i]
    for (let j = i + 1; j < adjacent.length; j++) {
      const b = adjacent[j]
      if (a[0] === b[0] && ((a[1] < b[1] && a[2] > b[2]) || (a[1] > b[1] && a[2] < b[2]))) {
        crossings++
      }
    }
  }
  return crossings
}

/**
 * Assign a cross-axis centre to every node so nodes line up under their
 * neighbours: each node drifts toward the average of its neighbours while
 * ranks keep their order and boxes keep `sep` between them.
 */
export function assignPositions(
  byRank: number[][],
  size: number[],
  sep: number,
  edges: Edge[],
  ranks: number[],
): number[] {
  const n = size.length
  const parents: number[][] = Array.from({ length: n }, () => [])
  const children: number[][] = Array.from({ length: n }, () => [])
  for (const e of edges) {
    if (e.from !== e.to && ranks[e.to] > ranks[e.from]) {
      parents[e.to].push(e.from)
      children[e.from].push(e.to)
    }
  }

  const pos = new Array<number>(n).fill(0)
  for (const row of byRank) {
    let x = 0
    for (const v of row) {
      const h = size[v] / 2
      x += h
      pos[v] = x
      x += h + sep
    }
  }

  for (let it = 0; it < 10; it++) {
    const rows = it % 2 === 0 ? byRank : [...byRank].reverse()
    const neigh = it % 2 === 0 ? parents : children
    for (const row of rows) relaxRank(row, neigh, pos, size, sep)
  }

  let minLeft = Number.POSITIVE_INFINITY
  for (let v = 0; v < n; v++) minLeft = Math.min(minLeft, pos[v] - size[v] / 2)
  if (!Number.isFinite(minLeft)) minLeft = 0
  return Array.from({ length: n }, (_, v) => Math.max(0, Math.round(pos[v] - minLeft)))
}

function relaxRank(
  nodes: number[],
  neigh: number[][],
  pos: number[],
  size: number[],
  sep: number,
): void {
  const n = nodes.length
  if (n === 0) return

  const desired = nodes.map((v) =>
    neigh[v].length === 0 ? pos[v] : neigh[v].reduce((s, u) => s + pos[u], 0) / neigh[v].length,
  )
  const halfOf = (i: number): number => size[nodes[i]] / 2

  // Sweep right then left, then take the midpoint: this centres a node between
  // the tightest packing that respects order from either side.
  const left = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    left[i] =
      i === 0 ? desired[i] : Math.max(desired[i], left[i - 1] + halfOf(i - 1) + sep + halfOf(i))
  }
  const right = new Array<number>(n)
  for (let i = n - 1; i >= 0; i--) {
    right[i] =
      i === n - 1
        ? desired[i]
        : Math.min(desired[i], right[i + 1] - halfOf(i + 1) - sep - halfOf(i))
  }
  for (let i = 0; i < n; i++) pos[nodes[i]] = (left[i] + right[i]) / 2
  for (let i = 1; i < n; i++) {
    const minP = pos[nodes[i - 1]] + halfOf(i - 1) + sep + halfOf(i)
    if (pos[nodes[i]] < minP) pos[nodes[i]] = minP
  }
}

/** A span competing for a track: `[start, end, from, to, edgeIndex]`. */
type Span5 = [number, number, number, number, number]

/**
 * Pack spans into as few parallel tracks as possible.
 *
 * Two spans share a track when they are two cells apart, or when they share an
 * endpoint — edges fanning out of one node deliberately reuse a single row so
 * a merge draws one arrowhead rather than a stack of them.
 */
export function assignTracks(spans: Span5[]): { assigned: [number, number][]; count: number } {
  const sorted = [...spans].sort((a, b) => {
    for (let i = 0; i < 5; i++) if (a[i] !== b[i]) return a[i] - b[i]
    return 0
  })
  const tracks: [number, number, number, number][][] = []
  const assigned: [number, number][] = []
  for (const [s, e, f, t, idx] of sorted) {
    let slot = tracks.findIndex((members) =>
      members.every(([s2, e2, f2, t2]) => e2 + 2 <= s || e + 2 <= s2 || f2 === f || t2 === t),
    )
    if (slot === -1) {
      tracks.push([])
      slot = tracks.length - 1
    }
    tracks[slot].push([s, e, f, t])
    assigned.push([idx, slot])
  }
  return { assigned, count: tracks.length }
}

const labelWidth = (label: string, room = LABEL_ROOM): number =>
  Math.min(stringWidth(label), room)

const isAdjacent = (e: Edge, ranks: number[]): boolean => ranks[e.to] === ranks[e.from] + 1
const isLane = (e: Edge, ranks: number[]): boolean => e.from !== e.to && !isAdjacent(e, ranks)

/** Edges from rank `r` to `r + 1` that must jog sideways, so need a bus row. */
function busSpans(
  graph: Graph,
  ranks: number[],
  centers: number[],
  r: number,
  exact: boolean,
): Span5[] {
  const out: Span5[] = []
  graph.edges.forEach((e, i) => {
    const jogs = exact
      ? centers[e.from] !== centers[e.to]
      : Math.abs(centers[e.from] - centers[e.to]) > 1
    if (e.from !== e.to && ranks[e.from] === r && ranks[e.to] === r + 1 && jogs) {
      out.push([
        Math.min(centers[e.from], centers[e.to]),
        Math.max(centers[e.from], centers[e.to]),
        e.from,
        e.to,
        i,
      ])
    }
  })
  return out
}

/** Edges skipping a rank or running backwards; these go around in a lane. */
function laneSpans(graph: Graph, ranks: number[], placed: Placed[], vertical: boolean): Span5[] {
  const out: Span5[] = []
  graph.edges.forEach((e, i) => {
    if (!isLane(e, ranks)) return
    const pf = placed[e.from]
    const pt = placed[e.to]
    const a = vertical ? Math.min(pf.cy, pt.cy) : Math.min(pf.cx, pt.cx)
    const b = vertical ? Math.max(pf.cy, pt.cy) : Math.max(pf.cx, pt.cx)
    out.push([a, b, e.from, e.to, i])
  })
  return out
}

interface Bands {
  edgeBus: number[]
  /** `tracks[r]` counts the band after rank `r`. */
  tracks: number[]
  /** Tracks in the band before the first rank. */
  leading: number
  /** Bus track a lane edge leaves on when a neighbouring box blocks the direct way out. */
  exitTrack: (number | null)[]
  /** Bus track a lane edge arrives on when a neighbouring box blocks the direct way in. */
  entryTrack: (number | null)[]
}

/**
 * Assign bus tracks, including the detours of skip and back edges.
 *
 * Those edges run to a lane beyond the diagram, and the straight way there
 * goes through any box further along the same rank. An edge whose box has a
 * neighbour in the way takes the band after its rank to reach the lane, and
 * one whose target has a neighbour arrives along the band before that rank.
 */
function planBands(
  graph: Graph,
  ranks: number[],
  byRank: number[][],
  centers: number[],
  exact: boolean,
): Bands {
  const edges = graph.edges.length
  const blocked = (n: number): boolean => byRank[ranks[n]].at(-1) !== n

  // One array of slots: bus tracks, then exit tracks, then entry tracks.
  const slots = new Array<number | null>(3 * edges).fill(null)
  const tracks = new Array<number>(byRank.length).fill(0)
  let leading = 0

  for (let r = -1; r < byRank.length; r++) {
    const spans = busSpans(graph, ranks, centers, r, exact)
    graph.edges.forEach((e, i) => {
      if (!isLane(e, ranks)) return
      if (ranks[e.from] === r && blocked(e.from)) {
        spans.push([centers[e.from], FAR, e.from, -1 - i, edges + i])
      }
      if (ranks[e.to] === r + 1 && blocked(e.to)) {
        spans.push([centers[e.to], FAR, -1 - i, e.to, 2 * edges + i])
      }
    })
    if (spans.length === 0) continue

    const { assigned, count } = assignTracks(spans)
    for (const [idx, slot] of assigned) slots[idx] = slot
    if (r < 0) leading = count
    else tracks[r] = count
  }

  return {
    edgeBus: slots.slice(0, edges).map((slot) => slot ?? 0),
    tracks,
    leading,
    exitTrack: slots.slice(edges, 2 * edges),
    entryTrack: slots.slice(2 * edges),
  }
}

function placeTd(
  ranks: number[],
  maxRank: number,
  byRank: number[][],
  sizes: NodeSizes,
  graph: Graph,
  placed: Placed[],
): RoutePlan {
  const centers = assignPositions(byRank, sizes.layW, GAP_X, graph.edges, ranks)

  const bands = planBands(graph, ranks, byRank, centers, false)

  const rankH = byRank.map((row) =>
    row.length === 0 ? 3 : Math.max(...row.map((i) => sizes.boxH[i] + sizes.extraH[i])),
  )
  const rankY = new Array<number>(maxRank + 1).fill(0)
  rankY[0] = bands.leading === 0 ? 0 : bands.leading + 1
  for (let r = 1; r <= maxRank; r++) {
    rankY[r] = rankY[r - 1] + rankH[r - 1] + Math.max(GAP_Y, bands.tracks[r - 1] + 1)
  }
  const trailing = bands.tracks[maxRank]
  const canvasH = rankY[maxRank] + rankH[maxRank] + (trailing === 0 ? 0 : trailing + 1)
  const bandEnd = Array.from({ length: maxRank + 1 }, (_, r) => rankY[r] + rankH[r])

  let diagramW = 1
  byRank.forEach((row, r) => {
    for (const idx of row) {
      const w = sizes.boxW[idx]
      const h = sizes.boxH[idx]
      const cx = centers[idx]
      const x = sat(cx, half(w))
      const y = rankY[r] + half(rankH[r] - h - sizes.extraH[idx])
      placed[idx] = { x, y, w, h, cx, cy: y + half(h), rank: r }
      diagramW = Math.max(diagramW, x + w)
      if (sizes.extraH[idx] > 0 && sizes.selfLabelW[idx] > 0) {
        diagramW = Math.max(diagramW, x + w + 2 + sizes.selfLabelW[idx])
      }
    }
  })

  let contentW = diagramW
  for (const e of graph.edges) {
    if (graph.compact || e.from === e.to || e.label === null) continue
    const lw = labelWidth(e.label)
    contentW =
      isAdjacent(e, ranks)
        ? Math.max(contentW, placed[e.to].cx + 3 + lw)
        : Math.max(contentW, diagramW + lw + 1)
  }

  const edgeLane = new Array<number>(graph.edges.length).fill(0)
  const lanes = laneSpans(graph, ranks, placed, true)
  let canvasW = contentW
  let laneBase = 0
  if (lanes.length > 0) {
    const { assigned, count } = assignTracks(lanes)
    for (const [idx, slot] of assigned) edgeLane[idx] = slot
    canvasW = contentW + 1 + count
    laneBase = contentW + 1
  }

  return { ...bands, canvasW, canvasH, bandEnd, laneBase, edgeLane }
}

function placeLr(
  ranks: number[],
  maxRank: number,
  byRank: number[][],
  sizes: NodeSizes,
  graph: Graph,
  placed: Placed[],
): RoutePlan {
  const colW = byRank.map((row) =>
    row.length === 0 ? 0 : Math.max(...row.map((i) => sizes.boxW[i])),
  )

  // Left-to-right edge labels sit on the line across the gap between columns,
  // so each gap has to be wide enough for the widest label crossing it.
  const labelRoom = new Array<number>(maxRank + 1).fill(0)
  for (const e of graph.edges) {
    if (e.label === null) continue
    if (isLane(e, ranks)) continue
    const r = ranks[e.from]
    labelRoom[r] = Math.max(labelRoom[r], labelWidth(e.label))
  }
  const gapRoom = (r: number): number => (labelRoom[r] === 0 ? GAP_X : labelRoom[r] + 2 * LABEL_PAD + 3)

  const centers = assignPositions(byRank, sizes.layH, 1, graph.edges, ranks)
  const bands = planBands(graph, ranks, byRank, centers, true)

  const rankX = new Array<number>(maxRank + 1).fill(0)
  rankX[0] = bands.leading === 0 ? 0 : bands.leading + 1
  for (let r = 1; r <= maxRank; r++) {
    rankX[r] = rankX[r - 1] + colW[r - 1] + 1 + bands.tracks[r - 1] + gapRoom(r - 1)
  }
  const selfTails = byRank[maxRank]
    .filter((i) => sizes.extraH[i] > 0 && sizes.selfLabelW[i] > 0)
    .map((i) => 2 + sizes.selfLabelW[i])
  const trailing = bands.tracks[maxRank]
  const canvasW =
    rankX[maxRank] +
    colW[maxRank] +
    (trailing === 0 ? 0 : trailing + 2) +
    (selfTails.length === 0 ? 0 : Math.max(...selfTails))
  // One column stays blank after the boxes so a bus never touches a box border.
  const bandEnd = Array.from({ length: maxRank + 1 }, (_, r) => rankX[r] + colW[r] + 1)

  let diagramH = 1
  byRank.forEach((row, r) => {
    const x = rankX[r]
    for (const idx of row) {
      const w = sizes.boxW[idx]
      const h = sizes.boxH[idx]
      const cy = centers[idx]
      const y = sat(cy, half(h + sizes.extraH[idx]))
      placed[idx] = { x, y, w, h, cx: x + half(w), cy: y + half(h), rank: r }
      diagramH = Math.max(diagramH, y + h + sizes.extraH[idx])
    }
  })

  const edgeLane = new Array<number>(graph.edges.length).fill(0)
  const lanes = laneSpans(graph, ranks, placed, false)
  let canvasH = diagramH
  let laneBase = 0
  if (lanes.length > 0) {
    const { assigned, count } = assignTracks(lanes)
    for (const [idx, slot] of assigned) edgeLane[idx] = slot
    canvasH = diagramH + 1 + count
    laneBase = diagramH + 1
  }

  return { ...bands, canvasW, canvasH, bandEnd, laneBase, edgeLane }
}

/** Rank, place, draw and route a graph onto a fresh canvas. */
export function layoutCanvas(graph: Graph, extras: NodeExtra[]): CanvasResult {
  const n = graph.nodes.length
  if (n === 0) return null

  const ranks = computeRanks(graph)
  const maxRank = Math.max(...ranks, 0)

  const byRank: number[][] = Array.from({ length: maxRank + 1 }, () => [])
  for (let idx = 0; idx < ranks.length; idx++) byRank[ranks[idx]].push(idx)
  orderRanks(byRank, graph.edges, ranks)

  const wrapped = graph.nodes.map((node) => wrapLabel(node.label, WRAP_WIDTH))

  const boxW = extras.map((extra, i) => {
    if (extra.kind === 'frame') {
      return Math.max(extra.sub.w + 2, stringWidth(graph.nodes[i].label) + 4)
    }
    if (extra.kind === 'compartments') return Math.max(1, widest(extra.sections.flat())) + 2 * PAD + 2
    return Math.max(1, widest(wrapped[i])) + 2 * PAD + 2
  })
  const boxH = extras.map((extra, i) => {
    if (extra.kind === 'frame') return extra.sub.h + 2
    if (extra.kind === 'compartments') {
      const filled = extra.sections.filter((s) => s.length > 0).length
      return extra.sections.reduce((s, sec) => s + sec.length, 0) + sat(filled, 1) + 2
    }
    return wrapped[i].length + 2
  })

  // A self-edge needs two rows below its box, and room beside it for a label.
  const extraH = new Array<number>(n).fill(0)
  const selfLabelW = new Array<number>(n).fill(0)
  for (const e of graph.edges) {
    if (e.from !== e.to) continue
    extraH[e.from] = 2
    if (e.label !== null) {
      selfLabelW[e.from] = Math.max(selfLabelW[e.from], labelWidth(e.label))
    }
  }
  for (let i = 0; i < n; i++) if (extraH[i] > 0) boxW[i] = Math.max(boxW[i], 7)

  // A label beside an arrow sits level with its sibling boxes' arrows, so it needs a clear lane.
  const sideLabelW = new Array<number>(n).fill(0)
  for (const e of graph.edges) {
    if (graph.compact || e.label === null || !isAdjacent(e, ranks)) continue
    sideLabelW[e.to] = Math.max(sideLabelW[e.to], labelWidth(e.label, SIDE_LABEL_ROOM))
  }

  const sizes: NodeSizes = {
    boxW,
    boxH,
    layW: boxW.map((w, i) => Math.max(w + sideRoom(selfLabelW[i]), sideRoom(sideLabelW[i]))),
    layH: boxH.map((h, i) => h + extraH[i]),
    extraH,
    selfLabelW,
  }

  const placed: Placed[] = Array.from({ length: n }, () => ({
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    cx: 0,
    cy: 0,
    rank: 0,
  }))

  const vertical = graph.dir === 'down' || graph.dir === 'up'
  const plan = vertical
    ? placeTd(ranks, maxRank, byRank, sizes, graph, placed)
    : placeLr(ranks, maxRank, byRank, sizes, graph, placed)

  if (plan.canvasW * plan.canvasH > MAX_CANVAS_CELLS) return null

  const canvas = new Canvas(plan.canvasW, plan.canvasH)
  for (let idx = 0; idx < n; idx++) {
    const extra = extras[idx]
    if (extra.kind === 'frame') drawFrame(canvas, placed[idx], graph.nodes[idx].label, extra.sub)
    else if (extra.kind === 'compartments') drawClassBox(canvas, placed[idx], extra.sections)
    else drawBox(canvas, placed[idx], wrapped[idx], graph.nodes[idx].shape)
  }

  const bandStart = (rank: number): number => (rank < 0 ? 0 : plan.bandEnd[rank])
  const trackAt = (rank: number, track: number | null): number | null =>
    track === null ? null : bandStart(rank) + track

  const routes = graph.edges.map((edge, i): Segment[] => {
    canvas.curStyle =
      edge.line === 'dotted' ? STY_DOT : edge.line === 'thick' ? STY_THICK : STY_SOLID
    if (edge.from === edge.to) return routeSelf(canvas, placed[edge.from], edge)

    const from = placed[edge.from]
    const to = placed[edge.to]
    if (to.rank === from.rank + 1) {
      const bus = bandStart(from.rank) + plan.edgeBus[i]
      return vertical
        ? routeForward(canvas, from, to, edge, bus)
        : routeForwardLr(canvas, from, to, edge, bus)
    }

    const lane = plan.laneBase + plan.edgeLane[i]
    const exit = trackAt(from.rank, plan.exitTrack[i])
    const entry = trackAt(to.rank - 1, plan.entryTrack[i])
    return vertical
      ? routeBack(canvas, from, to, edge, lane, exit, entry)
      : routeBackLr(canvas, from, to, edge, lane, exit, entry)
  })

  placeLabels(canvas, graph, routes)
  canvas.finalizeMask()
  return canvas
}

/** Apply the direction flip a finished canvas needs for `BT` / `RL`. */
export function orient(canvas: Canvas, graph: Graph): Canvas {
  if (graph.dir === 'up') canvas.flipVertical()
  else if (graph.dir === 'left') canvas.flipHorizontal()
  return canvas
}

/** Flowchart and state diagrams: plain boxes, no extra content. */
export function layoutFlowchart(graph: Graph): CanvasResult {
  const extras: NodeExtra[] = graph.nodes.map(() => ({ kind: 'plain' }))
  const canvas = layoutCanvas(graph, extras)
  return canvas && orient(canvas, graph)
}

/** Class and ER diagrams: boxes divided into title / attribute / method rows. */
export function layoutClass(graph: Graph, infos: ClassInfo[]): CanvasResult {
  const extras: NodeExtra[] = graph.nodes.map((node, i) => {
    const title: string[] = []
    if (infos[i].annotation !== null) title.push(`«${infos[i].annotation}»`)
    title.push(displayGenerics(node.label))
    return { kind: 'compartments', sections: [title, infos[i].attrs, infos[i].methods] }
  })
  const canvas = layoutCanvas(graph, extras)
  return canvas && orient(canvas, graph)
}

function displayGenerics(s: string): string {
  let out = ''
  let open = false
  for (const c of s) {
    if (c === '~') {
      out += open ? '>' : '<'
      open = !open
    } else {
      out += c
    }
  }
  return out
}

type ItemKey = string
const nodeKey = (i: number): ItemKey => `n${i}`
const groupKey = (i: number): ItemKey => `g${i}`

/**
 * Lay out a flowchart that uses `subgraph`.
 *
 * Each subgraph becomes a framed box holding its own independently laid-out
 * canvas. An edge is drawn in the innermost scope containing both endpoints;
 * one crossing a subgraph boundary attaches to the frame instead of the node.
 */
export function layoutGrouped(graph: Graph): CanvasResult {
  // A node whose id matches a subgraph id stands in for that subgraph.
  const proxy = new Map<number, number>()
  graph.groups.forEach((g, gi) => {
    const ni = graph.index.get(g.id)
    if (ni !== undefined) proxy.set(ni, gi)
  })

  const groupChain = (g: number | null): number[] => {
    const chain: number[] = []
    let cur = g
    while (cur !== null) {
      chain.push(cur)
      cur = graph.groups[cur].parent
    }
    return chain.reverse()
  }
  const endpoint = (n: number): { key: ItemKey; chain: number[] } => {
    const gi = proxy.get(n)
    return gi === undefined
      ? { key: nodeKey(n), chain: groupChain(graph.nodeGroup[n]) }
      : { key: groupKey(gi), chain: groupChain(graph.groups[gi].parent) }
  }

  /** Edges bucketed by the scope that draws them; `null` is the top level. */
  const scopeEdges = new Map<number | null, [ItemKey, ItemKey, number][]>()
  const referenced = new Array<boolean>(graph.groups.length).fill(false)
  graph.edges.forEach((e, ei) => {
    const f = endpoint(e.from)
    const t = endpoint(e.to)
    let k = 0
    while (k < f.chain.length && k < t.chain.length && f.chain[k] === t.chain[k]) k++
    const scope = k === 0 ? null : f.chain[k - 1]
    const fKey = f.chain.length > k ? groupKey(f.chain[k]) : f.key
    const tKey = t.chain.length > k ? groupKey(t.chain[k]) : t.key
    for (const key of [fKey, tKey]) {
      if (key.startsWith('g')) referenced[Number(key.slice(1))] = true
    }
    const list = scopeEdges.get(scope)
    if (list) list.push([fKey, tKey, ei])
    else scopeEdges.set(scope, [[fKey, tKey, ei]])
  })

  const directNodes = new Map<number | null, number[]>()
  graph.nodeGroup.forEach((g, ni) => {
    if (proxy.has(ni)) return
    const list = directNodes.get(g)
    if (list) list.push(ni)
    else directNodes.set(g, [ni])
  })

  // Drop empty subgraphs, but keep any that an edge attaches to.
  const keep = new Array<boolean>(graph.groups.length).fill(false)
  for (let gi = graph.groups.length - 1; gi >= 0; gi--) {
    const hasNodes = (directNodes.get(gi) ?? []).length > 0
    const hasChildren = graph.groups.some((g, c) => g.parent === gi && keep[c])
    keep[gi] = hasNodes || hasChildren || referenced[gi]
  }

  const canvas = buildScope(graph, null, scopeEdges, directNodes, keep)
  return canvas && orient(canvas, graph)
}

function buildScope(
  graph: Graph,
  scope: number | null,
  scopeEdges: Map<number | null, [ItemKey, ItemKey, number][]>,
  directNodes: Map<number | null, number[]>,
  keep: boolean[],
): CanvasResult {
  const items: ItemKey[] = (directNodes.get(scope) ?? []).map(nodeKey)
  const childGroups = graph.groups
    .map((_, gi) => gi)
    .filter((gi) => graph.groups[gi].parent === scope && keep[gi])
  items.push(...childGroups.map(groupKey))

  if (items.length === 0) return new Canvas(1, 1)

  const indexOf = new Map<ItemKey, number>()
  const nodes: Node[] = []
  const extras: NodeExtra[] = []
  for (const item of items) {
    indexOf.set(item, nodes.length)
    const i = Number(item.slice(1))
    if (item.startsWith('n')) {
      nodes.push({ label: graph.nodes[i].label, shape: graph.nodes[i].shape })
      extras.push({ kind: 'plain' })
    } else {
      const sub = buildScope(graph, i, scopeEdges, directNodes, keep)
      if (sub === null) return null
      nodes.push({ label: graph.groups[i].label, shape: 'rect' })
      extras.push({ kind: 'frame', sub })
    }
  }

  const edges: Edge[] = []
  for (const [f, t, ei] of scopeEdges.get(scope) ?? []) {
    const fi = indexOf.get(f)
    const ti = indexOf.get(t)
    if (fi === undefined || ti === undefined) continue
    const e = graph.edges[ei]
    edges.push({
      from: fi,
      to: ti,
      label: e.label,
      headTo: e.headTo,
      headFrom: e.headFrom,
      line: e.line,
    })
  }

  // Layout only reads nodes/edges/dir/compact, so a bare Graph carrying those is enough.
  const synth = new Graph(graph.dir)
  synth.compact = graph.compact
  synth.nodes = nodes
  synth.edges = edges
  return layoutCanvas(synth, extras)
}

export function drawBox(canvas: Canvas, p: Placed, lines: string[], shape: Shape): void {
  const { x, y, w, h } = p
  const right = x + w - 1
  const bottom = y + h - 1

  const rounded = shape === 'round' || shape === 'diamond'
  canvas.set(x, y, rounded ? '╭' : '┌', 'border')
  canvas.set(right, y, rounded ? '╮' : '┐', 'border')
  canvas.set(x, bottom, rounded ? '╰' : '└', 'border')
  canvas.set(right, bottom, rounded ? '╯' : '┘', 'border')

  // The perimeter is drawn as bits so edges can tee into it, but it is the box
  // outline, so it claims `border` rather than `edge`.
  for (let cx = x + 1; cx < right; cx++) {
    canvas.addBits(cx, y, L | R, 'border')
    canvas.addBits(cx, bottom, L | R, 'border')
  }
  for (let cy = y + 1; cy < bottom; cy++) {
    canvas.addBits(x, cy, U | D, 'border')
    canvas.addBits(right, cy, U | D, 'border')
  }

  for (let cy = y; cy <= bottom; cy++) {
    for (let cx = x; cx <= right; cx++) canvas.occupied[canvas.idx(cx, cy)] = 1
  }

  const inner = Math.max(1, sat(w, 2 * PAD + 2))
  lines.forEach((line, li) => {
    const textX = x + 1 + PAD + half(sat(inner, stringWidth(line)))
    drawText(canvas, line, textX, y + 1 + li, 'text')
  })
}

/** A class or ER box: sections separated by horizontal rules, title centred. */
function drawClassBox(canvas: Canvas, p: Placed, sections: string[][]): void {
  drawBox(canvas, p, [], 'rect')
  const inner = Math.max(1, sat(p.w, 2 * PAD + 2))
  let row = p.y + 1
  let first = true
  sections.forEach((section, si) => {
    if (section.length === 0) return
    if (!first) {
      canvas.set(p.x, row, '├', 'border')
      for (let x = p.x + 1; x < p.x + p.w - 1; x++) canvas.set(x, row, '─', 'border')
      canvas.set(p.x + p.w - 1, row, '┤', 'border')
      row++
    }
    first = false
    for (const line of section) {
      const tx = si === 0 ? p.x + 1 + PAD + half(sat(inner, stringWidth(line))) : p.x + 1 + PAD
      drawTextOverEdges(canvas, line, tx, row, 'text')
      row++
    }
  })
}

/** A subgraph frame: a titled box with a finished sub-canvas centred inside. */
function drawFrame(canvas: Canvas, p: Placed, title: string, sub: Canvas): void {
  drawBox(canvas, p, [], 'rect')
  drawTextOverEdges(canvas, ` ${title} `, p.x + 1, p.y, 'text')
  canvas.legend.push(...sub.legend)
  canvas.blit(sub, p.x + 1 + half(p.w - 2 - sub.w), p.y + 1 + half(p.h - 2 - sub.h))
}

function headGlyph(head: Head, arrow: string): string {
  switch (head) {
    case 'circle':
      return 'o'
    case 'cross':
      return '×'
    case 'diamondFill':
      return '◆'
    case 'diamondOpen':
      return '◇'
    case 'triangle':
      return { '▼': '▽', '▲': '△', '◄': '◁', '▶': '▷' }[arrow] ?? arrow
    default:
      return arrow
  }
}

/** The arrowhead at the end of an edge, or `bits` finishing the line when it has none. */
function drawHead(canvas: Canvas, head: Head, arrow: string, x: number, y: number, bits: number): void {
  if (head === 'none') canvas.addBits(x, y, bits)
  else canvas.set(x, y, headGlyph(head, arrow), 'edge')
}

function drawTail(canvas: Canvas, head: Head, arrow: string, x: number, y: number): void {
  if (head !== 'none') canvas.set(x, y, headGlyph(head, arrow), 'edge')
}

/** Adjacent ranks, top-down: drop, jog along the bus row, drop into the head. */
function routeForward(canvas: Canvas, from: Placed, to: Placed, edge: Edge, bus: number): Segment[] {
  const tx = to.cx
  // A jog of one column reads as a kink; snap straight instead.
  const bx = Math.abs(from.cx - tx) <= 1 ? tx : from.cx
  const by = from.y + from.h - 1
  const headRow = to.y - 1

  canvas.junction(bx, by, D)
  canvas.segV(bx, by, bus)
  if (bx === tx) {
    canvas.segV(bx, bus, headRow)
  } else {
    canvas.segH(bus, bx, tx)
    canvas.segV(tx, bus, headRow)
  }

  drawHead(canvas, edge.headTo, '▼', tx, headRow, U)
  drawTail(canvas, edge.headFrom, '▲', bx, by)

  if (bx === tx) return [vSegment(tx, by + 1, headRow)]
  return [vSegment(tx, bus, headRow), hSegment(bus, bx, tx), vSegment(bx, by + 1, bus)]
}

/** A self-edge: a stub loop hanging below the box. */
function routeSelf(canvas: Canvas, p: Placed, edge: Edge): Segment[] {
  const bottom = p.y + p.h - 1
  const exitX = p.cx + 1
  const retX = p.x + p.w - 2
  if (retX <= exitX || bottom + 2 >= canvas.h) return []

  const [v, h, bl, br] =
    edge.line === 'dotted'
      ? ['╎', '╌', '╰', '╯']
      : edge.line === 'thick'
        ? ['┃', '━', '┗', '┛']
        : ['│', '─', '╰', '╯']

  canvas.junction(exitX, bottom, D)
  canvas.set(exitX, bottom + 1, v, 'edge')
  canvas.set(exitX, bottom + 2, bl, 'edge')
  for (let x = exitX + 1; x < retX; x++) canvas.set(x, bottom + 2, h, 'edge')
  canvas.set(retX, bottom + 2, br, 'edge')
  canvas.set(retX, bottom + 1, headGlyph(edge.headTo, '▲'), 'edge')
  return [vSegment(retX, bottom + 1, bottom + 2)]
}

/**
 * Skip or back edge, top-down: out to a lane past the right of the diagram,
 * along it, and back in. `exit` and `entry` are the bus rows that replace the
 * straight run out of `from` and into `to` when a neighbouring box blocks it.
 */
function routeBack(
  canvas: Canvas,
  from: Placed,
  to: Placed,
  edge: Edge,
  laneX: number,
  exit: number | null,
  entry: number | null,
): Segment[] {
  const out: Segment[] = []
  const laneStart = exit ?? from.cy

  if (exit === null) {
    const sx = from.x + from.w - 1
    canvas.junction(sx, laneStart, R)
    canvas.segH(laneStart, sx, laneX)
    drawTail(canvas, edge.headFrom, '◄', sx, laneStart)
    out.push(hSegment(laneStart, sx, laneX))
  } else {
    const by = from.y + from.h - 1
    canvas.junction(from.cx, by, D)
    canvas.segV(from.cx, by, exit)
    canvas.segH(exit, from.cx, laneX)
    drawTail(canvas, edge.headFrom, '▲', from.cx, by)
    out.push(hSegment(exit, from.cx, laneX))
  }

  if (entry === null) {
    const tx = to.x + to.w - 1
    canvas.segV(laneX, laneStart, to.cy)
    canvas.segH(to.cy, tx + 1, laneX)
    drawHead(canvas, edge.headTo, '◄', tx + 1, to.cy, R)
    out.unshift(hSegment(to.cy, tx + 1, laneX))
  } else {
    const headRow = to.y - 1
    canvas.segV(laneX, laneStart, entry)
    canvas.segH(entry, to.cx, laneX)
    canvas.segV(to.cx, entry, headRow)
    drawHead(canvas, edge.headTo, '▼', to.cx, headRow, U)
    out.unshift(hSegment(entry, to.cx, laneX))
  }

  return out
}

/** Adjacent ranks, left-to-right: out the right side, jog on the bus column. */
function routeForwardLr(canvas: Canvas, from: Placed, to: Placed, edge: Edge, bus: number): Segment[] {
  const rx = from.x + from.w - 1
  const ry = from.cy
  const ly = to.cy
  const headCol = to.x - 1

  canvas.junction(rx, ry, R)
  canvas.segH(ry, rx, bus)
  if (ry === ly) {
    canvas.segH(ry, bus, headCol)
  } else {
    canvas.segV(bus, ry, ly)
    canvas.segH(ly, bus, headCol)
  }

  drawHead(canvas, edge.headTo, '▶', headCol, ly, R)
  drawTail(canvas, edge.headFrom, '◄', rx, ry)

  if (ry === ly) return [hSegment(ly, rx, headCol)]
  return [hSegment(ly, bus, headCol), vSegment(bus, ry, ly), hSegment(ry, rx, bus)]
}

/**
 * Skip or back edge, left-to-right: out to a lane below the diagram, along it,
 * and back in. `exit` and `entry` are the bus columns that replace the straight
 * run out of `from` and into `to` when a neighbouring box blocks it.
 */
function routeBackLr(
  canvas: Canvas,
  from: Placed,
  to: Placed,
  edge: Edge,
  laneY: number,
  exit: number | null,
  entry: number | null,
): Segment[] {
  const laneStart = exit ?? from.cx
  const stub: Segment[] = []

  if (exit === null) {
    const sy = from.y + from.h - 1
    canvas.junction(laneStart, sy, D)
    canvas.segV(laneStart, sy, laneY)
    drawTail(canvas, edge.headFrom, '▲', laneStart, sy)
  } else {
    const rx = from.x + from.w - 1
    canvas.junction(rx, from.cy, R)
    canvas.segH(from.cy, rx, exit)
    stub.push(hSegment(from.cy, rx, exit))
    canvas.segV(exit, from.cy, laneY)
    drawTail(canvas, edge.headFrom, '◄', rx, from.cy)
  }

  if (entry === null) {
    const ty = to.y + to.h - 1
    canvas.segH(laneY, laneStart, to.cx)
    canvas.segV(to.cx, laneY, ty + 1)
    drawHead(canvas, edge.headTo, '▲', to.cx, ty + 1, D)
    return [hSegment(laneY, laneStart, to.cx), ...stub]
  }

  const headCol = to.x - 1
  canvas.segH(laneY, laneStart, entry)
  canvas.segV(entry, laneY, to.cy)
  canvas.segH(to.cy, entry, headCol)
  drawHead(canvas, edge.headTo, '▶', headCol, to.cy, R)
  return [hSegment(laneY, laneStart, entry), hSegment(to.cy, entry, headCol), ...stub]
}

/**
 * Put each edge label on its own route, once every line is down so nothing
 * drawn later can run through one. A label is placed whole or not at all, and
 * one with no room goes in the canvas legend, naming the edge it belongs to.
 */
function placeLabels(canvas: Canvas, graph: Graph, routes: Segment[][]): void {
  const shared = sharedCells(canvas, routes)

  graph.edges.forEach((edge, i) => {
    if (edge.label === null) return
    const text = edge.label

    if (!routes[i].some((segment) => placeOnSegment(canvas, shared, text, segment))) {
      const from = oneLine(graph.nodes[edge.from].label)
      const to = oneLine(graph.nodes[edge.to].label)
      canvas.legend.push(`${from} → ${to}: ${text}`)
    }
  })
}

const oneLine = (label: string): string => label.replace(/\s*\n\s*/g, ' ')

/** Cells lying on more than one edge's route, where a label would not say whose it was. */
function sharedCells(canvas: Canvas, routes: Segment[][]): Uint8Array {
  const claimed = new Uint8Array(canvas.w * canvas.h)
  const shared = new Uint8Array(canvas.w * canvas.h)
  for (const route of routes) {
    for (const segment of route) {
      if (segment.axis === 'v') continue
      for (let x = segment.x0; x <= segment.x1 && x < canvas.w; x++) {
        const i = canvas.idx(x, segment.y)
        if (claimed[i]) shared[i] = 1
        claimed[i] = 1
      }
    }
  }
  return shared
}

function placeOnSegment(
  canvas: Canvas,
  shared: Uint8Array,
  text: string,
  segment: Segment,
): boolean {
  const w = stringWidth(text)
  if (segment.axis === 'v') return placeBesideLine(canvas, text, w, segment)

  const { y, x0, x1 } = segment
  const mid = half(x0 + x1 - w)
  for (const x of outwardFrom(mid, x0 + 1, x1 - w - 2)) {
    if (!runsOnLine(canvas, shared, x, y, w + 2 * LABEL_PAD)) continue
    drawTextOverEdges(canvas, ` ${text} `, x, y, 'edgeLabel')
    return true
  }
  for (const row of [y - 1, y + 1]) {
    for (const x of outwardFrom(mid, x0 + 1, x1 - w)) {
      if (!isBlank(canvas, x, row, w)) continue
      drawText(canvas, text, x, row, 'edgeLabel')
      return true
    }
  }
  return false
}

function placeBesideLine(
  canvas: Canvas,
  text: string,
  w: number,
  segment: Extract<Segment, { axis: 'v' }>,
): boolean {
  const { x, y0, y1 } = segment
  for (let y = y1; y >= y0; y--) {
    for (const start of [x + 1 + LABEL_PAD, x - LABEL_PAD - w]) {
      if (start < 0 || !isBlank(canvas, start, y, w)) continue
      drawText(canvas, text, start, y, 'edgeLabel')
      return true
    }
  }
  return false
}

/** `lo..=hi` ordered by distance from `mid`, so a label stays centred if it can. */
function* outwardFrom(mid: number, lo: number, hi: number): Generator<number> {
  for (let d = 0; mid - d >= lo || mid + d <= hi; d++) {
    if (mid - d >= lo && mid - d <= hi) yield mid - d
    if (d > 0 && mid + d >= lo && mid + d <= hi) yield mid + d
  }
}

function runsOnLine(canvas: Canvas, shared: Uint8Array, x: number, y: number, w: number): boolean {
  if (y < 0 || y >= canvas.h || x + w > canvas.w) return false
  for (let k = 0; k < w; k++) {
    const i = canvas.idx(x + k, y)
    if (canvas.mask[i] !== (L | R) || canvas.ch[i] !== ' ' || canvas.occupied[i] || shared[i]) {
      return false
    }
  }
  return true
}

function isBlank(canvas: Canvas, x: number, y: number, w: number): boolean {
  if (y < 0 || y >= canvas.h || x + w > canvas.w) return false
  for (let cx = x - LABEL_PAD; cx < x + w + LABEL_PAD; cx++) {
    if (cx < 0 || cx >= canvas.w) continue
    const i = canvas.idx(cx, y)
    if (canvas.ch[i] !== ' ' || canvas.mask[i] !== 0 || canvas.occupied[i]) return false
  }
  return true
}
