/**
 * Shared between the TUI half and the server half of the plugin.
 *
 * The two halves run in different processes. Identity lives in a reserved,
 * inert permission rule on the fork: the v2 update API cannot change metadata.
 * Binding the rule to both session IDs prevents an ordinary fork from becoming
 * a side conversation just by inheriting its parent's rules or changing title.
 */

export const PLUGIN_ID = "side"

/** Prefix stamped onto the title of every side conversation. */
export const SIDE_TITLE_PREFIX = "⑂ side · "

const SIDE_ID_ACTION = "opencode-side.identity:"

export function sideIdentity(sessionID: string, parentID: string) {
  return { action: SIDE_ID_ACTION + sessionID, resource: parentID, effect: "deny" as const }
}

export type SideSession = {
  /** The session this side conversation was forked from. */
  readonly parentID: string
}

export function sideTitle(parentTitle: string | undefined): string {
  const base = (parentTitle ?? "").replace(SIDE_TITLE_PREFIX, "").trim()
  return SIDE_TITLE_PREFIX + (base.length > 0 ? base : "untitled")
}

/** Reads the durable marker, independent of the display title. */
export function readSideSession(session: unknown): SideSession | undefined {
  if (!session || typeof session !== "object") return undefined
  const record = session as {
    id?: unknown
    fork?: { sessionID?: unknown }
    permissions?: unknown
  }
  const parentID = record.fork?.sessionID
  if (typeof record.id !== "string" || typeof parentID !== "string" || !parentID.trim()) return undefined
  if (!Array.isArray(record.permissions)) return undefined
  const marker = sideIdentity(record.id, parentID)
  if (!record.permissions.some((rule) => rule && rule.action === marker.action
    && rule.resource === marker.resource && rule.effect === marker.effect)) return undefined
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

// Unknown MCP/custom actions are not assumed read-only. A wildcard covers every
// permission-gated action, including read actions; no allow exception overrides
// a stricter policy inherited from the main thread.

export type ReadonlyMode = "ask" | "deny" | "off"

export type SideOptions = {
  /** Keybind for toggling between a side conversation and its parent. */
  keybind?: string
  /** Delete the ephemeral fork when the side conversation is closed. Default true. */
  cleanup?: boolean
  /** Inject the side-conversation system prompt. Default true. */
  boundary?: boolean
  /** How permission-gated tools behave inside a side conversation. Default "ask". */
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
  return [{ action: "*", resource: "*", effect: mode }]
}
