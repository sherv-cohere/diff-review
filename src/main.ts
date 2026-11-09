import { parseArgs } from 'node:util'

import type { Mode } from './types'

const MODES: Mode[] = ['worktree', 'branch', 'commit', 'turn', 'review']

const USAGE = `Usage:
  diff-review [worktree|branch|commit|turn|review]  review the changes; from Claude Code (! diff-review) it opens beside Claude
  diff-review --here [mode] [--claude-pane ID]      review in this terminal
  diff-review hook prompt-submit|turn-start|stop    the Claude Code hooks that send comments and record turns
`

type Args = { mode: Mode | undefined; isHere: boolean; claudePane: string | undefined; hook: string | undefined }

function usage(code: number): never {
  process.stdout.write(USAGE)
  process.exit(code)
}

function readArgs(argv: string[]): Args {
  const options = { here: { type: 'boolean' }, 'claude-pane': { type: 'string' }, help: { type: 'boolean', short: 'h' } } as const
  let parsed
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true })
  } catch {
    return usage(2)
  }

  const { values, positionals } = parsed
  if (values.help === true) return usage(0)

  const [first, second, ...rest] = positionals
  if (first === 'hook') return { mode: undefined, isHere: false, claudePane: undefined, hook: second ?? '' }

  const mode = MODES.find(one => one === first)
  if ((first !== undefined && mode === undefined) || second !== undefined || rest.length > 0) return usage(2)
  return { mode, isHere: values.here === true, claudePane: values['claude-pane'], hook: undefined }
}

async function main(): Promise<void> {
  const args = readArgs(process.argv.slice(2))

  // Hooks run on every prompt, so they skip loading the viewer and its highlighter.
  if (args.hook !== undefined) {
    const { runHook } = await import('./hooks')
    return runHook(args.hook)
  }

  const { launch } = await import('./app')
  await launch(args)
}

main().catch(error => {
  process.stderr.write(`diff-review: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
