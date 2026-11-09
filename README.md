# diff-review

A terminal diff viewer for reviewing what Claude Code changes, built to run beside a Claude Code session in Rex. You read the diff, select lines, write comments on them, and each comment's token lands in Claude's prompt; when you send the prompt, a Claude Code hook expands those tokens into the comment text and the code it refers to.

## What it shows

The viewer has five modes, switched with `m` or the number keys `1`–`5`:

| Mode | Shows |
| --- | --- |
| Worktree | Uncommitted changes. |
| Branch | Everything since a base you pick with `b`. |
| Commit | One commit's changes. |
| Turn | What one Claude turn changed, including files changed through Bash. |
| Since review | What changed after you last sent comments, so you can check how Claude answered them. |

Files can be shown in a tree by folder or grouped by change. Grouping (`o`) asks Haiku, through `claude -p`, to sort the changed files into the parts a reviewer would read together and order them the way the author would explain the change. Markdown files have a rendered preview (`v`) that draws Mermaid diagrams as text, and you can comment on the preview as well as the source.

## Requirements

- [Bun](https://bun.sh) to run the built binary, and Node 22 or later with npm to build it.
- Git.
- Rex for opening beside Claude and typing comment tokens into its prompt. Without Rex the viewer still runs in the current terminal, and tells you which token to type yourself.
- The `claude` CLI on your PATH, for grouping.

## Install

```sh
npm install
npm run build
ln -s "$PWD/dist/diff-review.mjs" ~/.local/bin/diff-review
```

Then add the hooks to `~/.claude/settings.json`. `prompt-submit` is the one Claude waits on, since it supplies the comment text; the other two only record turns and run in the background.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "diff-review hook prompt-submit", "timeout": 15 },
          { "type": "command", "command": "diff-review hook turn-start", "async": true }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [{ "type": "command", "command": "diff-review hook stop", "async": true }]
      }
    ]
  }
}
```

Without the hooks the viewer still works for Worktree, Branch and Commit, but comments are never expanded for Claude and Turn mode has nothing to show.

## Usage

From inside Claude Code, run `! diff-review` to open the viewer in a Rex pane to the right of Claude. From any other terminal, `diff-review` opens it in place. A mode can be given as an argument, such as `diff-review branch`.

```
diff-review [worktree|branch|commit|turn|review]
diff-review --here [mode] [--claude-pane ID]
diff-review hook prompt-submit|turn-start|stop
```

`--here` forces the viewer into the current terminal, and `--claude-pane` names the Rex pane to send comment tokens to when it can't be found by looking for a `claude` process in the same repository.

To comment, click a line, or drag or shift-click to select a range, then write the comment in the box that opens. Its token, such as `[#3 git.ts:L40-52]`, is typed into Claude's prompt; you can write around it and send several at once.

### Keys

| Key | Action |
| --- | --- |
| `j` `k`, arrows, `space`, `pageup` `pagedown`, `g` `G` | Scroll |
| `h` `l` | Scroll sideways |
| `n` `p` (or `]` `[`) | Next or previous change |
| `J` `K` | Next or previous file |
| `/` | Search files |
| `x` | Mark the file viewed |
| `e` | Expand all hidden context |
| `m`, `1`–`5` | Change mode |
| `b` | Pick the base, commit or turn for the current mode |
| `s` | Side by side or unified |
| `t` | File tree |
| `o` | Group by change; `O` regroups |
| `#` | Line numbers |
| `w` | Wrap long lines |
| `v` | Markdown preview |
| `r` | Refresh |
| `V` | View menu |
| `q` | Quit |

## How it works

The viewer and the hooks share state through JSON files in `.git/diff-review/` of each worktree: comments not yet sent, recorded turns, the turn in progress, files marked viewed, and the last review point. The `turn-start` hook snapshots the worktree when a prompt is sent and `stop` records the turn when Claude finishes, so Turn mode sees every file change regardless of which tool made it. When a prompt carries comment tokens, `prompt-submit` returns their text as additional context for Claude, removes them from the pending list, and snapshots the worktree as the start of Since review mode.

Display options and file groupings are cached under `$XDG_CACHE_HOME/diff-review` (or `~/.cache/diff-review`).

The source is in `src/`: `main.ts` reads arguments, `app.ts` sets up the terminal and Rex, `controller.ts` holds the review state, `git.ts` builds listings and diffs, `hooks.ts` is the Claude Code side, and `viewer.ts` with `src/viewer/` draws everything. `vendor/grok-mermaid` is a modified copy of [grok-mermaid](https://github.com/xl0/grok-mermaid) used for the diagrams; its README lists the changes.

## Development

```sh
npm test           # vitest
npm run typecheck  # tsc for src, test and the vendored package
npm run build      # bundle to dist/diff-review.mjs
```
