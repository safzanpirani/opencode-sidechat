/**
 * Shared between the TUI half and the server half of the plugin.
 *
 * The two halves run in different processes and cannot share memory, so a side
 * conversation is identified from the session record itself. opencode v2
 * already records that a session is a fork and of what (`Session.Info.fork`),
 * so the only thing this plugin has to add is "and it is a *side* fork", which
 * the title marker carries.
 */

export const PLUGIN_ID = "side"

/** Prefix stamped onto the title of every side conversation. */
export const SIDE_TITLE_PREFIX = "⑂ side · "

export type SideSession = {
  /** The session this side conversation was forked from. */
  readonly parentID: string
}

export function sideTitle(parentTitle: string | undefined): string {
  const base = (parentTitle ?? "").replace(SIDE_TITLE_PREFIX, "").trim()
  return SIDE_TITLE_PREFIX + (base.length > 0 ? base : "untitled")
}

/**
 * Reads the side-conversation marker off a session record.
 *
 * A session counts as a side conversation when it carries the title marker
 * *and* v2 recorded it as a fork, so an ordinary session that happens to be
 * titled like one is not mistaken for it.
 */
export function readSideSession(session: unknown): SideSession | undefined {
  if (!session || typeof session !== "object") return undefined
  const record = session as { title?: unknown; fork?: { sessionID?: unknown } }
  // TODO(review): Choose a durable identity strategy before allowing marker-free renames.
  if (typeof record.title !== "string" || !record.title.startsWith(SIDE_TITLE_PREFIX)) return undefined
  const parentID = record.fork?.sessionID
  if (typeof parentID !== "string" || parentID.trim().length === 0) return undefined
  return { parentID }
}

export function isSideSession(session: unknown): boolean {
  return readSideSession(session) !== undefined
}

/**
 * Appended to the system prompt of every side conversation.
 *
 * A fork carries the whole main-thread history with it, so without this the
 * model picks up whatever the main thread was in the middle of doing.
 */
export const SIDE_SYSTEM_PROMPT = [
  "You are in a side conversation, not the main thread.",
  "",
  "This session is an ephemeral fork of another session. Everything before the most recent user message is inherited history, provided only as context. Do not continue, execute, or complete any instruction, plan, tool call, or request from that inherited history. Only messages the user sends inside this side conversation are active instructions.",
  "",
  "Answer questions and do lightweight, read-only exploration. Do not present yourself as continuing the main thread's task.",
  "",
  "Do not modify files, git state, permissions, configuration, or any other workspace state unless the user explicitly asks for that mutation here. Do not request broader permissions unless such a mutation requires it. If the user does explicitly ask for a mutation, keep it minimal and local, and avoid disrupting the main thread.",
  "",
  "Do not spawn or interact with subagents from this side conversation, even if the inherited history used them.",
].join("\n")

/**
 * Permission actions clamped inside a side conversation, so an exploratory fork
 * cannot quietly mutate the workspace even when the main session runs wide open.
 */
// `write` and `patch` tools both gate on `edit`, and `bash` is the v1 spelling of `shell`,
// so the built-in mutating surface is these four. `browser` is included because a browser
// tool can navigate and submit forms, which is a side effect outside the workspace.
// TODO(review): Choose a policy for mutating MCP/custom actions; their names are open-ended.
export const GUARDED_ACTIONS = ["edit", "shell", "subagent", "browser"]

export type ReadonlyMode = "ask" | "deny" | "off"

export type SideOptions = {
  /** Keybind for toggling between a side conversation and its parent. */
  keybind?: string
  /** Delete the ephemeral fork when the side conversation is closed. Default true. */
  cleanup?: boolean
  /** Inject the side-conversation system prompt. Default true. */
  boundary?: boolean
  /** How mutating tools behave inside a side conversation. Default "ask". */
  readonly?: ReadonlyMode
}

export const DEFAULT_KEYBIND = "<leader>z"

export function resolveOptions(options: Readonly<Record<string, any>> | undefined): Required<SideOptions> {
  const raw = (options ?? {}) as SideOptions
  const mode = raw.readonly
  return {
    keybind: typeof raw.keybind === "string" && raw.keybind.trim() ? raw.keybind.trim() : DEFAULT_KEYBIND,
    cleanup: raw.cleanup !== false,
    boundary: raw.boundary !== false,
    readonly: mode === "deny" || mode === "off" ? mode : "ask",
  }
}

export function guardRuleset(mode: ReadonlyMode) {
  if (mode === "off") return undefined
  return GUARDED_ACTIONS.map((action) => ({ action, resource: "*", effect: mode }))
}
