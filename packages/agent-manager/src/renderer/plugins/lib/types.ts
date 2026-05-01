// Shared types for the plugins view. The RPC type isn't imported here on
// purpose to avoid the kernel→plugin type coupling pain — the screen
// projects out of `rpc.registry.getRegistry()` into this canonical shape.

export type PluginEntry = {
  name: string
  title?: string
  description: string
  repo: string
  installed: boolean
  enabled: boolean
  local: boolean
  manifestPath: string | null
  installPath: string
  /**
   * Absolute URL (`http://localhost:<wsPort>/plugin-screenshot/<name>/<path>`
   * for installed plugins, or a raw GitHub URL for registry-listed remote
   * plugins). Undefined when the plugin doesn't ship one — the card falls
   * back to an initial-letter gradient tile.
   */
  screenshot?: string
}

export type RepoInfo = {
  stars: number
  forks: number
  defaultBranch: string
  updatedAt: string
  htmlUrl: string
  description: string
  ownerLogin: string
}

export type ReadmeState = { content: string } | { error: string }

export type Activity = {
  kind: "install" | "update" | "uninstall"
  startedAt: number
  log: string[]
  error?: string
  done?: boolean
}

export type DiscoverKey = "all" | "installed" | "updates" | "local"
