/** One entry of `.claude/workspace.json`, as written there. */
export type WorkspaceFolder = {
  /** Short name the commands and the pane use. */
  name: string
  /** Relative to the primary repo, or absolute. */
  path: string
  /** `owner/repo` or a git URL, used to clone the folder when it is missing. */
  repo?: string
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
}

declare module 'claude-code' {
  interface PluginState {
    workspace: { roots: WorkspaceRoot[]; note: string }
  }
}
