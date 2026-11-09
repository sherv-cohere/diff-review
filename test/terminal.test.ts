import { expect, test, vi } from 'vitest'

import { Line } from '../src/surface'
import { InputParser, Screen } from '../src/terminal'

function parse(...chunks: string[]) {
  const parser = new InputParser()
  return chunks.flatMap(chunk => parser.feed(chunk))
}

test('arrows, page keys and letters arrive as the names the viewer handles', () => {
  expect(parse('\x1b[A\x1b[6~jG ')).toEqual([
    { kind: 'key', event: { key: 'up' } },
    { kind: 'key', event: { key: 'pagedown' } },
    { kind: 'key', event: { key: 'j' } },
    { kind: 'key', event: { key: 'G' } },
    { kind: 'key', event: { key: 'space' } },
  ])
})

test('the kitty keyboard tells Shift+Enter and Escape apart from other keys', () => {
  expect(parse('\x1b[13;2u\x1b[27u\r')).toEqual([
    { kind: 'key', event: { key: 'return', shift: true } },
    { kind: 'key', event: { key: 'escape' } },
    { kind: 'key', event: { key: 'return' } },
  ])
})

test('Option+arrow and Ctrl+W reach the comment editor as word moves and deletes', () => {
  expect(parse('\x1b[1;3D\x17')).toEqual([
    { kind: 'key', event: { key: 'left', meta: true } },
    { kind: 'key', event: { key: 'w', ctrl: true } },
  ])
})

test('mouse reports become a press, a drag and a release in 0-based cells, and the wheel scrolls', () => {
  expect(parse('\x1b[<0;5;3M\x1b[<32;6;4M\x1b[<0;6;4m\x1b[<65;10;2M')).toEqual([
    { kind: 'pointer', event: { type: 'down', x: 4, y: 2, button: 'left' } },
    { kind: 'pointer', event: { type: 'move', x: 5, y: 3, button: 'left' } },
    { kind: 'pointer', event: { type: 'up', x: 5, y: 3, button: 'left' } },
    { kind: 'wheel', axis: 'vertical', by: 1, x: 9, y: 1 },
  ])
})

test('a sideways trackpad swipe and a shifted wheel scroll horizontally', () => {
  expect(parse('\x1b[<66;1;1M\x1b[<67;1;1M\x1b[<69;1;1M')).toEqual([
    { kind: 'wheel', axis: 'horizontal', by: -1, x: 0, y: 0 },
    { kind: 'wheel', axis: 'horizontal', by: 1, x: 0, y: 0 },
    { kind: 'wheel', axis: 'horizontal', by: 1, x: 0, y: 0 },
  ])
})

test('a paste arrives whole, newlines included, so it lands in the comment as typed text', () => {
  expect(parse('\x1b[200~line one\nline two\x1b[201~')).toEqual([{ kind: 'key', event: { key: 'line one\nline two' } }])
})

test('a sequence split across two reads is joined instead of read as Escape and stray keys', () => {
  expect(parse('\x1b[<0;5', ';3M')).toEqual([{ kind: 'pointer', event: { type: 'down', x: 4, y: 2, button: 'left' } }])
})

test('a row is erased before it is written, so a full row keeps its last character', () => {
  const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  const full = new Line(3)
  full.add('abc')

  new Screen().paint([full], 1)

  const written = String(write.mock.calls[0]?.[0])
  expect(written.indexOf('\x1b[K')).toBeLessThan(written.indexOf('abc'))
  write.mockRestore()
})
