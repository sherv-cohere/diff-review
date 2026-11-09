import { watch } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { type AllFiles, combineFiles } from './all-files'
import { INTERNAL_ENV, readJson, type ReviewPoint, run, type SharedComments, type StateFiles, writeJson } from './bridge'
import { buildComment, changeRanges, Git, parseRows, type Range, splitByFile } from './git'
import { type CachedGrouping, closestGrouping, fitGroups, GROUPING_SYSTEM, groupingPrompt, parseGroups, remember } from './grouping'
import type { Actions, Choice, FileEntry, FileGroup, FileView, Grouping, Listing, Mode, NewComment, Options, PickKind, ReviewComment, Row, SentOutcome, Toggle, TurnSnapshot, ViewerComment, ViewerFile, ViewerProps } from './types'
import { CONTEXT } from './viewer/model'
import { buildGroupedTree, buildTree } from './viewer/tree'

// Past this many files the all-files view is not tried, so its loading stays quick.
const ALL_FILES_LIMIT = 200

// Enough viewed marks for several long reviews; the oldest go first.
const VIEWED_KEPT = 2_000

const GROUPING_MODEL = 'haiku'
const GROUPING_TIMEOUT_MS = 90_000

/** The options and groupings kept across runs, in the user's cache directory. */
function cacheFile(name: 'options.json' | 'groupings.json'): string {
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'diff-review', name)
}

const DEFAULT_OPTIONS: Options = { layout: 'split', showTree: true, preview: false, wrap: false, lineNumbers: true, groupedModes: [] }

/** What the controller needs from the program around it. */
export type Host = {
  /** The props changed; draw again. */
  changed(): void
  toast(text: string): void
  /** Types text at the end of Claude's prompt. */
  appendToPrompt(text: string): Promise<void>
  leave(): void
  quit(): void
}


function viewedKey(file: FileEntry): string {
  return `${file.path}\0${file.version}`
}

type SentComment = ReviewComment & { sent: SentOutcome }

function rangeKey(listing: Listing): string {
  return `${listing.from}:${listing.to}`
}

function detailKey(listing: Listing, path: string): string {
  return `${rangeKey(listing)}:${path}`
}

/** Moves a comment's rows to where its line numbers sit in the file's current rows. */
function reanchor<T extends ReviewComment>(comment: T, rows: Row[]): T {
  const startRow = rows.findIndex(row => row[comment.side] === comment.start)
  const endRow = rows.findIndex(row => row[comment.side] === comment.end)

  return startRow < 0 || endRow < 0 ? { ...comment, startRow: -1, endRow: -1 } : { ...comment, startRow, endRow }
}

function toggleOption(options: Options, what: Exclude<Toggle, 'grouped'>): Options {
  if (what === 'layout') return { ...options, layout: options.layout === 'split' ? 'unified' : 'split' }
  return { ...options, [what]: !options[what] }
}

export class Controller {
  private mode: Mode = 'worktree'
  private listing: Listing | null = null
  private error: string | null = null
  private isLoading = false
  private current: string | null = null
  private comments: ReviewComment[] = []
  private review: ReviewPoint | null = null
  /** In "Since review", the sent comments on lines of the changed version, which are this diff's old side. */
  private sent: SentComment[] = []
  private nextCommentId = 1
  private options: Options = DEFAULT_OPTIONS
  private turns: TurnSnapshot[] = []
  private picked: Record<PickKind, string | null> = { branch: null, commit: null, turn: null }
  private choices: { kind: PickKind; list: Choice[] } | null = null
  private grouping: Grouping | null = null
  private view: FileView = 'all'
  /** Each viewed file's path and version, so a mark lapses once the file changes again. */
  private viewed = new Set<string>()

  /** Whole-file rows by trees and path, for a file shown alone or carrying comments. */
  private readonly details = new Map<string, Row[]>()
  /** Each file's changed hunks with their context, by trees and path, for the all-files view. */
  private readonly hunkRows = new Map<string, Row[]>()
  /** The all-files view last drawn, which maps a comment's rows back to its file. */
  private lastAll: AllFiles | null = null
  private combined: { sig: string; all: AllFiles } | null = null
  private cachedProps: ViewerProps | null = null

  private handling: Promise<unknown> = Promise.resolve()

  private readonly cwd: string
  private readonly git: Git
  private readonly files: StateFiles
  private readonly host: Host

  constructor(cwd: string, files: StateFiles, host: Host) {
    this.cwd = cwd
    this.git = new Git(cwd)
    this.files = files
    this.host = host
  }

  async start(mode: Mode | undefined): Promise<void> {
    this.options = { ...DEFAULT_OPTIONS, ...(await readJson<Partial<Options>>(cacheFile('options.json'), {})) }
    this.turns = await readJson<TurnSnapshot[]>(this.files.turns, [])
    this.viewed = new Set(await readJson<string[]>(this.files.viewed, []))
    const shared = await readJson<SharedComments>(this.files.comments, { label: '', comments: [] })
    this.comments = shared.comments
    this.review = await readJson<ReviewPoint | null>(this.files.review, null)
    // Sent comments show beside new ones in "Since review", and the viewer tells comments apart by id.
    const ids = [...this.comments, ...(this.review?.comments ?? [])].map(comment => comment.id)
    this.nextCommentId = Math.max(0, ...ids) + 1

    this.watchState()
    await this.loadListing(mode ?? this.mode)
  }

  readonly actions: Actions = {
    setMode: mode =>
      this.queue(() => {
        this.view = 'all'
        return this.loadListing(mode)
      }),
    selectFile: path => this.queue(() => this.selectFile(path)),
    addComment: comment => this.queue(() => this.addComment(comment)),
    editComment: (id, text) => this.queue(() => this.editComment(id, text)),
    deleteComment: id => this.queue(() => this.deleteComment(id)),
    toggleViewed: path => this.queue(() => this.toggleViewed(path)),
    toggle: what => this.queue(() => (what === 'grouped' ? this.toggleGrouped() : this.setOptions(toggleOption(this.options, what)))),
    setTreeWidth: width => this.queue(() => this.setOptions({ ...this.options, treeWidth: width })),
    pick: (kind, id) =>
      this.queue(() => {
        this.picked = { ...this.picked, [kind]: id === '' ? null : id }
        this.view = 'all'
        return this.loadListing(kind)
      }),
    loadChoices: kind => this.queue(() => this.loadChoices(kind)),
    openFile: path =>
      this.queue(() => {
        this.view = 'opened'
        return this.selectFile(path)
      }),
    showAll: () => this.queue(() => this.showAll()),
    refresh: () =>
      this.queue(() => {
        this.details.clear()
        this.hunkRows.clear()
        return this.loadListing(this.mode)
      }),
    regroup: () => this.groupIfAsked('fresh'),
    leave: () => this.host.leave(),
    quit: () => this.host.quit(),
  }

  /** Runs the viewer's requests one at a time, in the order they came. */
  private queue(work: () => Promise<void>): void {
    this.handling = this.handling.then(work).catch(error => this.host.toast(String(error)))
  }

  /** The viewer's props, rebuilt only after something changed. */
  props(): ViewerProps {
    this.cachedProps ??= this.buildProps()
    return this.cachedProps
  }

  private changed(): void {
    this.cachedProps = null
    this.host.changed()
  }

  // --- the hooks' files ----------------------------------------------------------------

  /** Follows the hooks: a turn that changed files reloads the view, a sent comment leaves it, and sending them moves the review point. */
  private watchState(): void {
    watch(this.files.dir, (_, name) => {
      if (name === 'turns.json') void this.onTurns()
      if (name === 'comments.json') void this.onSharedComments()
      if (name === 'review.json') void this.onReview()
    }).unref()
  }

  private async onReview(): Promise<void> {
    this.review = await readJson<ReviewPoint | null>(this.files.review, null)
    // The review point was just snapshotted, so it doubles as the worktree.
    if (this.mode === 'review') await this.loadListing('review', this.review?.from ?? null)
  }

  private async onTurns(): Promise<void> {
    const turns = await readJson<TurnSnapshot[]>(this.files.turns, [])
    const latest = turns[0]
    if (latest === undefined || latest.id === this.turns[0]?.id) return
    this.turns = turns

    // A picked commit or turn cannot change with the worktree.
    const isPinned = (this.mode === 'commit' || this.mode === 'turn') && this.picked[this.mode] !== null
    if (!isPinned) await this.loadListing(this.mode, latest.to)
  }

  private async onSharedComments(): Promise<void> {
    const shared = await readJson<SharedComments>(this.files.comments, { label: '', comments: [] })
    const kept = new Set(shared.comments.map(comment => comment.id))
    if (this.comments.every(comment => kept.has(comment.id))) return

    this.comments = this.comments.filter(comment => kept.has(comment.id))
    this.changed()
  }

  private async shareComments(): Promise<void> {
    const shared: SharedComments = { label: this.listing?.label ?? '', comments: this.comments }
    await writeJson(this.files.comments, shared)
  }

  // --- git -----------------------------------------------------------------------------

  /** `worktree` is a tree of the worktree already written, saving another snapshot. */
  private async fetchRange(mode: Mode, worktree: string | null): Promise<(Range & { label: string }) | string> {
    if (mode === 'review') {
      if (this.review === null) return 'No comments sent yet. "Since review" shows what changed after you last sent comments to Claude.'

      const range = await this.git.worktreeRange(worktree)
      if (typeof range === 'string') return range
      return { ...range, from: this.review.from, label: `${range.branch} · since your comments` }
    }

    if (mode === 'turn') {
      const turn = this.turns.find(one => one.id === this.picked.turn) ?? this.turns[0]
      if (turn === undefined) return 'No Claude turn has changed files yet. Turns are recorded by the diff-review hooks.'

      return { from: turn.from, to: turn.to, label: `files changed in the turn "${turn.label}"`, branch: '', target: this.picked.turn === null ? '' : turn.label }
    }

    const range = await { worktree: () => this.git.worktreeRange(worktree), branch: () => this.git.branchRange(this.picked.branch, worktree), commit: () => this.git.commitRange(this.picked.commit) }[mode]()
    if (typeof range === 'string') return range

    const { branch, target } = range
    const label = { worktree: `${branch} · uncommitted`, branch: `${branch} → ${target}`, commit: `commit ${target}` }[mode]
    return { ...range, label }
  }

  /** Loads the list for the pick select that opened, or drops it as the select closes. */
  private async loadChoices(kind: PickKind | null): Promise<void> {
    if (kind === null) {
      this.choices = null
      return this.changed()
    }

    let list: Choice[]
    if (kind === 'turn') list = this.turns.map(turn => ({ id: turn.id, label: turn.label }))
    else {
      list = kind === 'branch' ? await this.git.refs() : await this.git.commits(this.picked.branch)
    }
    this.choices = { kind, list }
    this.changed()
  }

  private async loadListing(mode: Mode, worktree: string | null = null): Promise<void> {
    this.isLoading = true
    this.error = null
    this.changed()

    const range = await this.fetchRange(mode, worktree)
    if (typeof range === 'string') {
      this.mode = mode
      this.error = range
      this.listing = null
      this.isLoading = false
      return this.changed()
    }

    const listing: Listing = { mode, ...range, ...(await this.git.listing(range.from, range.to)) }
    this.listing = listing
    this.mode = mode
    this.sent = mode === 'review' ? (this.review?.comments ?? []).filter(c => c.side === 'new').map(c => ({ ...c, side: 'old', startRow: -1, endRow: -1, sent: 'unchanged' })) : []
    this.groupIfAsked()

    const isStillListed = listing.files.some(file => file.path === this.current)
    this.current = isStillListed ? this.current : (listing.files[0]?.path ?? null)
    if (this.view !== 'opened') this.setView((await this.loadAll(listing)) ? 'all' : 'too-large')
    if (this.view !== 'all' && this.current !== null) await this.loadDetail(listing, this.current)

    this.isLoading = false
    this.changed()
  }

  private async loadDetail(listing: Listing, path: string): Promise<void> {
    await this.fetchRows(listing, path)

    const rows = this.details.get(detailKey(listing, path)) ?? []
    this.reanchorAll(one => (one === path ? rows : undefined))
    this.changed()
  }

  private async fetchRows(listing: Listing, path: string): Promise<void> {
    const key = detailKey(listing, path)
    if (this.details.has(key)) return

    const rows = await this.git.fileRows(listing.from, listing.to, path, listing.oldPaths[path])
    if (this.details.size > ALL_FILES_LIMIT * 2) this.details.clear()
    this.details.set(key, rows)
  }

  /**
   * Loads what the all-files view shows: every file's hunks from one diff of the whole range, and the
   * whole rows of files carrying comments, which may sit away from a change. False when the files are
   * too many to show together.
   */
  private async loadAll(listing: Listing): Promise<boolean> {
    if (listing.files.length > ALL_FILES_LIMIT) return false

    const isMissing = listing.files.some(file => !file.isBinary && !this.hunkRows.has(detailKey(listing, file.path)))
    const commented = [...new Set(this.shownComments().map(comment => comment.path))].filter(path => listing.files.some(file => file.path === path))
    const [ran] = await Promise.all([isMissing ? this.git.hunks(listing.from, listing.to, CONTEXT) : null, ...commented.map(path => this.fetchRows(listing, path))])
    if (ran !== null) {
      // Past the output limit the split would drop files; they load one by one when opened instead.
      if (ran.isStdoutTruncated) return false
      const paths = listing.files.map(file => file.path)
      for (const [path, hunks] of splitByFile(ran.stdout, paths)) this.hunkRows.set(detailKey(listing, path), parseRows(hunks))
    }

    this.reanchorAll(path => this.details.get(detailKey(listing, path)))
    this.changed()
    return true
  }

  /** The comments drawn on the diff: those not yet sent and, in "Since review", the ones sent. */
  private shownComments(): (ReviewComment | SentComment)[] {
    return [...this.comments, ...this.sent]
  }

  private reanchorAll(rowsOf: (path: string) => Row[] | undefined): void {
    this.comments = this.comments.map(comment => {
      const rows = rowsOf(comment.path)
      return rows === undefined ? comment : reanchor(comment, rows)
    })
    this.sent = this.sent.map(comment => {
      const rows = rowsOf(comment.path)
      if (rows === undefined) return comment

      const anchored = reanchor(comment, rows)
      const isChanged = rows.slice(anchored.startRow, anchored.endRow + 1).some(row => row.kind !== 'context')
      return { ...anchored, sent: isChanged ? 'changed' : 'unchanged' }
    })
  }

  /** A file's rows in the all-files view: whole when comments anchor to it, else its hunks. */
  private allFilesRows(listing: Listing, path: string): Row[] | undefined {
    const whole = this.details.get(detailKey(listing, path))
    const isOnPath = (comment: ReviewComment) => comment.path === path
    const isCommented = whole !== undefined && (this.comments.some(isOnPath) || this.sent.some(isOnPath))
    return isCommented ? whole : (this.hunkRows.get(detailKey(listing, path)) ?? whole)
  }

  private async selectFile(path: string): Promise<void> {
    if (this.listing === null) return
    this.current = path
    await this.loadDetail(this.listing, path)
  }

  private async showAll(): Promise<void> {
    if (this.listing === null) return
    this.setView((await this.loadAll(this.listing)) ? 'all' : 'too-large')
    this.changed()
  }

  /** Tells the person once when the changes become too large to show together, not on every reload. */
  private setView(view: FileView): void {
    if (view === 'too-large' && this.view !== 'too-large') this.host.toast('These changes are too large to show together; showing one file at a time.')
    this.view = view
  }

  private async setOptions(options: Options): Promise<void> {
    this.options = options
    this.changed()
    await writeJson(cacheFile('options.json'), options).catch(() => undefined)
  }

  // --- grouping --------------------------------------------------------------------------

  /** Starts grouping the listed files when their mode is grouped, without holding up what asked. */
  private groupIfAsked(reuse: 'cache' | 'fresh' = 'cache'): void {
    const listing = this.listing
    if (listing !== null && this.options.groupedModes.includes(listing.mode)) {
      void this.groupFiles(listing, reuse).catch(error => this.host.toast(`Grouping stopped: ${String(error)}`))
    }
  }

  private async toggleGrouped(): Promise<void> {
    const { groupedModes } = this.options
    const next = groupedModes.includes(this.mode) ? groupedModes.filter(one => one !== this.mode) : [...groupedModes, this.mode]
    await this.setOptions({ ...this.options, groupedModes: next })
    this.groupIfAsked()
  }

  /** Groups the listing from the cache where one fits, else asks Haiku; `fresh` always asks. */
  private async groupFiles(listing: Listing, reuse: 'cache' | 'fresh'): Promise<void> {
    const key = rangeKey(listing)
    const known = this.grouping
    const isSettled = known?.key === key && (known.status === 'pending' || (known.status === 'ready' && reuse === 'cache'))
    if (isSettled) return

    const paths = listing.files.map(file => file.path)
    // The repository's root, which keeps cached groupings to the repository they were made in.
    const repo = this.cwd
    const cache = await readJson<CachedGrouping[]>(cacheFile('groupings.json'), [])
    const cached = reuse === 'cache' ? closestGrouping(cache, repo, key, paths) : null
    if (cached !== null) {
      // Only Haiku's groupings are stored; a reuse marks the one it came from as used.
      await writeJson(cacheFile('groupings.json'), remember(cache, { ...cached, usedAt: Date.now() }))
      this.grouping = { key, status: 'ready', groups: fitGroups(cached.groups, paths) }
      return this.changed()
    }

    this.grouping = { key, status: 'pending', startedAt: Date.now() }
    this.changed()
    const grouping = await this.askForGroups(listing).catch((error): Grouping => ({ key, status: 'failed', error: String(error) }))
    if (grouping.status === 'ready') {
      const latest = await readJson<CachedGrouping[]>(cacheFile('groupings.json'), [])
      await writeJson(cacheFile('groupings.json'), remember(latest, { key, repo, groups: grouping.groups, usedAt: Date.now() }))
    }

    // A newer listing may have started its own grouping meanwhile.
    if (this.grouping?.key === key) this.grouping = grouping
    this.changed()
    if (grouping.status === 'failed') this.host.toast(`Could not group the files (${grouping.error}); showing them by folder.`)
  }

  private async askForGroups(listing: Listing): Promise<Grouping> {
    const key = rangeKey(listing)
    // One line of context is what the grouping prompt quotes.
    const diff = await this.git.hunks(listing.from, listing.to, 1)
    const argv = ['claude', '-p', '--model', GROUPING_MODEL, '--system-prompt', GROUPING_SYSTEM, '--tools', '', '--settings', '{"disableAllHooks":true}']
    const reply = await run(argv, {
      cwd: this.cwd,
      input: groupingPrompt(listing, diff.stdout, diff.isStdoutTruncated),
      timeoutMs: GROUPING_TIMEOUT_MS,
      env: { ...process.env, [INTERNAL_ENV]: '1' },
    })
    if (reply.exitCode !== 0) {
      return { key, status: 'failed', error: reply.stderr.trim().split('\n')[0] || `claude exited with ${reply.exitCode}` }
    }

    const groups = parseGroups(reply.stdout, listing.files.map(file => file.path))
    return groups === null ? { key, status: 'failed', error: 'its reply held no groups' } : { key, status: 'ready', groups }
  }

  // --- comments and the prompt -----------------------------------------------------------

  /** The file a new comment is on, and the rows it covers in the view it was drawn in. */
  private commentPlace(comment: NewComment): { path: string; rows: Row[] } | null {
    const listing = this.listing
    const all = this.lastAll
    if (listing === null) return null
    if (all === null || comment.key !== all.file.key) {
      return this.current === null ? null : { path: this.current, rows: this.details.get(detailKey(listing, this.current)) ?? [] }
    }

    const start = all.places[comment.startRow]
    const end = all.places[comment.endRow]
    if (start === undefined || end === undefined || start.path !== end.path) return null

    return { path: start.path, rows: all.file.rows }
  }

  private async addComment(asked: NewComment): Promise<void> {
    const listing = this.listing
    const place = this.commentPlace(asked)
    if (listing === null || place === null) return

    const { path } = place
    const id = this.nextCommentId
    const draft = { id, path, side: asked.side, text: asked.text, quote: asked.quote, startRow: asked.startRow, endRow: asked.endRow }
    const built = buildComment(place.rows, draft)
    if (built === null) return

    // Comments anchor to the file's whole rows, which the all-files view then shows for this file.
    await this.fetchRows(listing, path)
    const comment = reanchor(built, this.details.get(detailKey(listing, path)) ?? [])
    this.nextCommentId += 1
    this.comments = [...this.comments, comment]
    this.changed()
    await this.shareComments()
    await this.host.appendToPrompt(`${comment.token} `)
  }

  private async editComment(id: number, text: string): Promise<void> {
    const trimmed = text.trim()
    if (trimmed === '') return

    this.comments = this.comments.map(comment => (comment.id === id ? { ...comment, text: trimmed } : comment))
    this.changed()
    await this.shareComments()
  }

  /** Forgets a comment; its token, if already typed into Claude's prompt, then expands to nothing. */
  private async deleteComment(id: number): Promise<void> {
    this.comments = this.comments.filter(one => one.id !== id)
    this.changed()
    await this.shareComments()
  }

  // --- viewed files -----------------------------------------------------------------------

  private async toggleViewed(path: string): Promise<void> {
    const entry = this.listing?.files.find(file => file.path === path)
    if (entry === undefined) return

    const key = viewedKey(entry)
    if (!this.viewed.delete(key)) this.viewed.add(key)
    this.changed()
    await writeJson(this.files.viewed, [...this.viewed].slice(-VIEWED_KEPT))
  }

  private viewedPaths(files: FileEntry[]): Set<string> {
    return new Set(files.filter(file => this.viewed.has(viewedKey(file))).map(file => file.path))
  }

  // --- the viewer --------------------------------------------------------------------------

  private viewerFile(listing: Listing, path: string, rows: Row[]): ViewerFile {
    const entry = listing.files.find(file => file.path === path)

    return {
      key: detailKey(listing, path),
      path,
      status: entry?.status ?? 'M',
      isBinary: entry?.isBinary ?? false,
      changes: changeRanges(rows),
      rows,
    }
  }

  /** Every file in one view, by group or else by folder, or null when they are not all loaded or are too many to try. */
  private allFiles(listing: Listing, files: FileEntry[], groups: FileGroup[] | null, viewed: ReadonlySet<string>): AllFiles | null {
    const rows = groups === null ? buildTree(files, '', new Set()) : buildGroupedTree(files, groups, '', new Set())
    const ordered = rows.flatMap(row => (row.kind === 'file' ? [row.entry] : []))
    const isLoaded = ordered.every(file => file.isBinary || this.allFilesRows(listing, file.path) !== undefined)
    if (files.length > ALL_FILES_LIMIT || !isLoaded) return null

    const anchored = this.shownComments().filter(c => c.endRow >= 0)
    const kept = (path: string) => anchored.filter(c => c.path === path).map((c): [number, number] => [c.startRow, c.endRow])

    // The order is in the key, so the viewer starts over when the groups arrive.
    const key = `${rangeKey(listing)}:${groups === null ? 'tree' : 'groups'}`
    // Combining walks every file's rows, so it reruns only when the files, their order or the comments change.
    const sig = `${key}:${ordered.map(file => file.path).join('\0')}:${anchored.map(c => `${c.path}:${c.startRow}:${c.endRow}`).join(',')}:${[...viewed].join('\0')}`
    if (this.combined?.sig !== sig) {
      // A viewed file folds to its header.
      const rowsOf = (path: string) => (viewed.has(path) ? [] : (this.allFilesRows(listing, path) ?? []))
      this.combined = { sig, all: combineFiles(key, ordered, rowsOf, kept) }
    }
    return this.combined.all
  }

  /** Each anchored comment with its rows as the all-files view numbers them. */
  private allComments(all: AllFiles): ViewerComment[] {
    const index = new Map(all.places.map((place, i) => [`${place.path}\0${place.row}`, i]))

    return this.shownComments().flatMap(comment => {
      const start = index.get(`${comment.path}\0${comment.startRow}`)
      const end = index.get(`${comment.path}\0${comment.endRow}`)
      return start === undefined || end === undefined ? [] : [{ ...comment, startRow: start, endRow: end }]
    })
  }

  private buildProps(): ViewerProps {
    const { listing, current, options, grouping } = this
    const isGroupingShown = listing !== null && options.groupedModes.includes(listing.mode) && grouping?.key === rangeKey(listing)

    const base: ViewerProps = {
      mode: this.mode,
      label: listing?.label ?? '',
      target: listing?.target ?? '',
      picked: this.picked,
      choices: this.choices,
      isLoading: this.isLoading,
      error: this.error,
      files: listing?.files ?? [],
      file: null,
      comments: [],
      options,
      grouping: isGroupingShown ? grouping : null,
      view: this.view,
      viewed: this.viewedPaths(listing?.files ?? []),
    }

    const groups = base.grouping?.status === 'ready' ? base.grouping.groups : null
    const all = listing === null || this.view !== 'all' ? null : this.allFiles(listing, base.files, groups, base.viewed)
    if (all !== null) {
      this.lastAll = all
      return { ...base, file: all.file, comments: this.allComments(all) }
    }

    const rows = listing === null || current === null ? undefined : this.details.get(detailKey(listing, current))
    if (listing === null || current === null || rows === undefined) return base

    const comments = this.shownComments().filter(comment => comment.path === current && comment.endRow >= 0)
    return { ...base, file: this.viewerFile(listing, current, rows), comments }
  }
}
