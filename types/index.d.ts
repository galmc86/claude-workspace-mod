/** One entry of `.claude/workspace.json`, as written there. */
export type WorkspaceFolder = {
  /** Short name the commands and the pane use. */
  name: string
  /** Relative to the primary repo, or absolute. */
  path: string
  /** `owner/repo` or a git URL, used to clone the folder when it is missing. */
  repo?: string
}

/** One changed file of a root, as `git status` reports it. */
export type WorkspaceChange = {
  /** VS Code's letter: M, A, D, R, U (untracked) or ! (conflict). */
  code: string
  /** Relative to the root. */
  path: string
}

/** One root of the workspace with its git state, as the pane shows it. */
export type WorkspaceRoot = {
  name: string
  /** Absolute. */
  path: string
  repo?: string
  isPrimary: boolean
  isMissing: boolean
  branch?: string
  ahead: number
  behind: number
  changed: number
  /** The first changed files, at most 100. */
  changes: WorkspaceChange[]
}

/** One entry of a folder the file tree has open. */
export type WorkspaceEntry = { name: string; isDir: boolean }

declare module 'claude-code' {
  interface PluginState {
    workspace: {
      roots: WorkspaceRoot[]
      note: string
      /** Roots the person collapsed, by absolute path. */
      closedRoots: string[]
      /** Folders open in the file tree, by absolute path. */
      openDirs: string[]
      /** Each open folder's entries, by absolute path. */
      listings: Record<string, WorkspaceEntry[]>
    }
  }
}
