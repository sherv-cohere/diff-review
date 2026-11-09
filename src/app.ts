import { run, stateFiles } from './bridge'
import { Controller, type Host } from './controller'
import { findClaudePane, focus, isClaudePane, openBeside, rexPlace, type RexPlace, typeInto } from './rex'
import { Line, type Surface } from './surface'
import { InputParser, Screen } from './terminal'
import type { Mode } from './types'
import { C } from './viewer/palette'
import { createViewer } from './viewer'

const TOAST_MS = 4_000

async function repoRoot(cwd: string): Promise<string | null> {
  const ran = await run(['git', 'rev-parse', '--show-toplevel'], { cwd })
  return ran.exitCode === 0 ? ran.stdout.trim() : null
}

/** The command that runs this same program again, for the pane Rex opens. */
function selfCommand(): string[] {
  return [process.execPath, process.argv[1] ?? 'diff-review']
}

/**
 * Opens the reviewer: beside the pane it was run from when that pane is Claude's or when there is no
 * terminal to draw in (a Rex key binding), otherwise in this terminal.
 */
export async function launch(args: { mode: Mode | undefined; isHere: boolean; claudePane: string | undefined }): Promise<void> {
  const cwd = process.cwd()
  const root = await repoRoot(cwd)
  if (root === null) throw new Error('diff-review runs inside a git repository.')

  const place = rexPlace()
  const isFromClaude = place !== null && !args.isHere && (await isClaudePane(place.session, place.block, root))
  const hasTerminal = process.stdout.isTTY === true
  if (place !== null && (isFromClaude || !hasTerminal)) {
    const paneArgs = isFromClaude ? ['--claude-pane', place.block] : []
    const argv = [...selfCommand(), '--here', ...paneArgs, ...(args.mode === undefined ? [] : [args.mode])]
    if (!(await openBeside(place.session, place.block, argv, root))) process.exitCode = 1
    return
  }

  await review(root, args.mode, place, args.claudePane)
}

async function review(root: string, mode: Mode | undefined, place: RexPlace | null, knownPane: string | undefined): Promise<void> {
  const files = await stateFiles(root)
  if (files === null) throw new Error('could not find the git directory.')

  const screen = new Screen()
  const parser = new InputParser()
  let toast: { text: string; until: number } | null = null
  let isQueued = false

  // Looking for Claude's pane asks Rex about every pane, so it runs alongside the first load instead of before it.
  let claudePane: Promise<string | null> =
    knownPane !== undefined ? Promise.resolve(knownPane) : place === null ? Promise.resolve(null) : findClaudePane(place, root)

  const quit = () => {
    screen.leave()
    process.exit(0)
  }

  const surface: Surface = {
    get columns() {
      return process.stdout.columns
    },
    get rows() {
      return process.stdout.rows
    },
    redraw: () => schedule(),
  }

  const host: Host = {
    changed: () => schedule(),
    toast: text => {
      toast = { text, until: Date.now() + TOAST_MS }
      setTimeout(schedule, TOAST_MS + 10)
      schedule()
    },
    appendToPrompt: async text => {
      if (place === null) return host.toast(`Not running in Rex; type ${text.trim()} in your prompt to send it.`)

      const known = await claudePane
      if (known !== null && (await typeInto(place.session, known, text, root)) === null) return

      // Claude may have started, restarted, or moved since the last lookup, so look again before giving up.
      claudePane = findClaudePane(place, root)
      const pane = await claudePane
      if (pane === null) return host.toast(`No Claude pane found in this session; type ${text.trim()} in your prompt to send it.`)

      const error = await typeInto(place.session, pane, text, root)
      if (error !== null) host.toast(`Could not type ${text.trim()} into Claude's pane (${error}); type it in your prompt to send it.`)
    },
    leave: () => {
      void claudePane.then(pane => {
        if (place !== null && pane !== null) return focus(place.session, pane, root)
      })
    },
    quit,
  }

  const controller = new Controller(root, files, host)
  const viewer = createViewer(controller.props(), surface, controller.actions)

  function frame(): void {
    isQueued = false
    const rows = surface.rows
    const lines = viewer.draw(controller.props())
    if (toast !== null && Date.now() < toast.until) {
      const line = new Line(surface.columns)
      line.add(` ${toast.text} `, { fg: C.fg, bg: C.button })
      lines[rows - 1] = line
    }
    screen.paint(lines, rows)
  }

  function schedule(): void {
    if (isQueued) return
    isQueued = true
    setImmediate(frame)
  }

  process.on('uncaughtException', error => {
    screen.leave()
    process.stderr.write(`${error.stack ?? String(error)}\n`)
    process.exit(1)
  })
  process.stdout.on('resize', () => {
    screen.invalidate()
    schedule()
  })

  process.stdin.setRawMode(true)
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    for (const input of parser.feed(chunk)) {
      if (input.kind === 'wheel') viewer.wheel(input.by, input.x, input.axis)
      else if (input.kind === 'pointer') viewer.pointer(input.event)
      else if (input.event.ctrl === true && input.event.key === 'c') quit()
      else viewer.key(input.event)
    }
  })

  screen.enter()
  schedule()
  await controller.start(mode)
}
