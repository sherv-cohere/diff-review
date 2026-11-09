import type { MermaidArt, RenderOptions } from './src/types'

export type { Cls, MermaidArt, RenderOptions, Span } from './src/types'
export function render(src: string, options?: RenderOptions): MermaidArt | null
