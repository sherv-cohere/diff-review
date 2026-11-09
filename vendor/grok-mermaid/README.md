grok-mermaid 0.2.3 (Apache-2.0, see LICENSE), https://github.com/xl0/grok-mermaid, modified for the
diff viewer and imported as source. Its truncation caps had no setting, and a reviewer has to see
everything a diagram says.

Changes from upstream:

- Text is never truncated. Node, participant and note text wraps, and `<br>` is kept as a line break.
- Edge labels are placed after all routing, on their own edge. A label is placed whole or listed in
  `MermaidArt.legend`, so two labels into one box cannot erase each other.
- Skip and back edges detour through the bands between ranks when a neighbouring box blocks them.
- The parser reads quoted inline labels, tags and hyphens inside inline labels, `@{ shape, label }`
  node attributes, and semicolons in sequence text.
- `render(src, { compact: true })` draws flowcharts top-down and wraps sequence text tighter.

`src/ansi.ts` and `src/source-box.ts` are left out because nothing here uses them.
