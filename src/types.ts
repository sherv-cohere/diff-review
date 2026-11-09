export type Mode = 'worktree' | 'branch' | 'commit' | 'turn' | 'review'

/** The modes with a second select: the branch's base, the commit, or the turn. */
export type PickKind = Exclude<Mode, 'worktree' | 'review'>

/** One entry of a pick list; the id is what is sent back when it is picked. */
export type Choice = { id: string; label: string }

export type Layout = 'split' | 'unified'

export type Side = 'old' | 'new'

export type FileStatus = 'A' | 'M' | 'D' | 'R'

/** `version` names the file's blobs before and after, so a viewed mark lapses once either side changes. */
export type FileEntry = { path: string; status: FileStatus; version: string; added: number; removed: number; isBinary: boolean }

export type RowKind = 'context' | 'added' | 'removed'

/** One line of either side; `old` and `new` are its line numbers, 0 where a side has no line. */
export type Row = { kind: RowKind; old: number; new: number; text: string }

export type Listing = {
  mode: Mode
  label: string
  branch: string
  /** What the second select shows: the base, the commit or the turn. */
  target: string
  from: string
  to: string
  files: FileEntry[]
  oldPaths: Record<string, string>
}

export type ReviewComment = {
  id: number
  path: string
  side: Side
  start: number
  end: number
  startRow: number
  endRow: number
  token: string
  text: string
  code: string
  /** The words highlighted in a markdown preview, which the comment is about. */
  quote?: string
}

/**
 * `groupedModes` are the modes whose files are ordered by the groups Haiku puts them in instead of by folder.
 * `treeWidth` is the file tree's width the person dragged it to; absent, a share of the pane.
 */
export type Options = { layout: Layout; showTree: boolean; preview: boolean; wrap: boolean; lineNumbers: boolean; groupedModes: Mode[]; treeWidth?: number }

/** Files that make sense reviewed together, and why. */
export type FileGroup = { title: string; why: string; paths: string[] }

/** The groups for one listing, by its `from:to` key, in the order to review them. */
export type Grouping =
  | { key: string; status: 'pending'; startedAt: number }
  | { key: string; status: 'ready'; groups: FileGroup[] }
  | { key: string; status: 'failed'; error: string }

/**
 * Whether every file shows in one scroll, one file shows because the person opened it from there, or
 * one file shows at a time because the changes are too large to show together.
 */
export type FileView = 'all' | 'opened' | 'too-large'

export type TurnSnapshot = { id: string; label: string; from: string; to: string }

/** One file's rows in an all-files view, from `start` up to `end`. */
export type Segment = FileEntry & { start: number; end: number }

/** A run of rows, its first `removed` rows removed and the rest added. */
export type Change = { start: number; end: number; removed: number }

export type ViewerFile = {
  key: string
  path: string
  status: FileStatus
  isBinary: boolean
  changes: Change[]
  rows: Row[]
  /** Present when the rows are every file's changed hunks, one segment per file. */
  segments?: Segment[]
}

/** Whether the lines a comment sent to Claude was on have changed since it was sent. */
export type SentOutcome = 'changed' | 'unchanged'

/** `sent` is present on a comment already sent to Claude, which the viewer shows but doesn't let you change. */
export type ViewerComment = Pick<ReviewComment, 'id' | 'side' | 'startRow' | 'endRow' | 'token' | 'text'> & { sent?: SentOutcome }

export type ViewerProps = {
  mode: Mode
  label: string
  target: string
  /** Each mode's picked id; null for its default. */
  picked: Record<PickKind, string | null>
  /** The list for the pick select that is open, null while none is. */
  choices: { kind: PickKind; list: Choice[] } | null
  isLoading: boolean
  error: string | null
  files: FileEntry[]
  file: ViewerFile | null
  comments: ViewerComment[]
  options: Options
  /** The current listing's grouping while its mode is grouped; null otherwise. */
  grouping: Grouping | null
  view: FileView
  /** The listed files marked viewed, which the all-files view folds to their headers. */
  viewed: ReadonlySet<string>
}

export type Toggle = 'layout' | 'showTree' | 'preview' | 'wrap' | 'lineNumbers' | 'grouped'

/** A comment as the viewer drew it: rows of the view `key` names, which may be the all-files view. */
export type NewComment = { key: string; side: Side; startRow: number; endRow: number; text: string; quote?: string }

/** What the viewer asks the controller to do; each answer arrives as new props. */
export type Actions = {
  setMode(mode: Mode): void
  selectFile(path: string): void
  addComment(comment: NewComment): void
  /** Rewrites a comment's text; its token stays the same, so a copy already in Claude's prompt still finds it. */
  editComment(id: number, text: string): void
  deleteComment(id: number): void
  toggleViewed(path: string): void
  toggle(what: Toggle): void
  setTreeWidth(width: number): void
  pick(kind: PickKind, id: string): void
  /** Loads the list for the picker of `kind` that opened; null drops it as the picker closes. */
  loadChoices(kind: PickKind | null): void
  /** Shows one file by itself, out of the all-files view. */
  openFile(path: string): void
  showAll(): void
  refresh(): void
  regroup(): void
  /** Hands the keyboard back to the Claude pane. */
  leave(): void
  quit(): void
}
