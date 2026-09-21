import type { Plugin } from "@opencode/plugin/tui"
import {
  PLUGIN_ID,
  guardRuleset,
  isSideSession,
  readSideSession,
  resolveOptions,
  sideTitle,
} from "./shared.js"

type State = {
  /** The open side conversation, if any. */
  side?: { sessionID: string; parentID: string }
  busy?: boolean
}

/**
 * Mirrors the Codex CLI `/side` command:
 *
 *   /side         start a side conversation in an ephemeral fork
 *   /sideswitch   switch between the side conversation and its parent
 *   /sideclose    return to the parent and discard the fork
 *
 * Only one side conversation is open at a time, and a side conversation cannot
 * itself spawn another.
 */
/**
 * Exported as a dependency-free plain object rather than through
 * `Plugin.define`. That helper is an identity function, but importing it pulls
 * `@opencode/plugin/tui` in at runtime, which reaches for `solid-js` — a peer
 * the TUI host provides and a standalone plugin bundle does not.
 */
const plugin = {
  id: PLUGIN_ID,
  setup(ctx) {
    const config = resolveOptions(ctx.options)

    // Ephemeral by design: a side conversation should not outlive the TUI, so
    // its pointer lives in memory rather than on disk.
    const [state, mutate] = ctx.storage.memory<State>("side", { initial: {} })

    let disposed = false
    let pending: Promise<void> | undefined

    function exclusive(action: () => Promise<void>) {
      if (disposed || state.busy) return
      mutate((draft) => { draft.busy = true })
      pending = action().catch(() => {
        fail("Side conversation operation failed. You can retry closing it.")
      }).finally(() => {
        mutate((draft) => { draft.busy = false })
      })
      return pending
    }

    function currentSessionID(): string | undefined {
      const route = ctx.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }

    function isSide(sessionID: string | undefined): boolean {
      if (!sessionID) return false
      if (state.side?.sessionID === sessionID) return true
      return isSideSession(ctx.data.session.get(sessionID))
    }

    function open(sessionID: string) {
      ctx.ui.router.navigate({ type: "session", sessionID })
      ctx.ui.dialog.clear()
    }

    function fail(message: string) {
      ctx.ui.toast.show({ variant: "error", message })
    }

    async function discard(sessionID: string) {
      await ctx.client.session.interrupt({ sessionID })
      if (!config.cleanup) return
      await ctx.client.session.remove({ sessionID })
    }

    async function start() {
      const parentID = currentSessionID()
      if (!parentID) {
        fail("/side is unavailable until a conversation is open.")
        return
      }
      if (isSide(parentID)) {
        fail("/side is unavailable in side conversations. Return to the main thread first.")
        return
      }
      if (state.side) {
        fail("A side conversation is already open. Return to it or close it before starting another.")
        return
      }

      const messages = await ctx.client.message.list({ sessionID: parentID, limit: 1 }).catch(() => undefined)
      if (!messages || messages.data.length === 0) {
        fail("/side is unavailable until the current conversation has started. Send a message first, then try /side again.")
        return
      }

      const side = await ctx.client.session.fork({ sessionID: parentID }).catch(() => undefined)
      if (!side?.id) {
        fail("Failed to start side conversation.")
        return
      }

      try {
        await ctx.client.session.update({
          sessionID: side.id,
          title: sideTitle(ctx.data.session.get(parentID)?.title),
          permissions: guardRuleset(config.readonly),
        })
      } catch {
        try {
          // An unguarded fork must be removed even when cleanup is disabled.
          await ctx.client.session.remove({ sessionID: side.id })
          fail("Failed to configure side conversation; the fork was removed.")
        } catch {
          fail(`Failed to configure or remove fork ${side.id}. Delete it manually before using it.`)
        }
        return
      }

      mutate((draft) => {
        draft.side = { sessionID: side.id, parentID }
      })
      if (disposed) return
      open(side.id)

      const [shortcut] = ctx.keymap.shortcuts("side.toggle")
      ctx.ui.toast.show({
        variant: "info",
        message: `Side conversation started. ${shortcut ?? "/sideswitch"} to switch back, /sideclose to discard it.`,
      })
    }

    function toggle() {
      if (disposed || state.busy) return
      const open_ = state.side
      if (!open_) {
        fail("No side conversation is open.")
        return
      }
      open(currentSessionID() === open_.sessionID ? open_.parentID : open_.sessionID)
    }

    async function close() {
      const open_ = state.side
      if (!open_) {
        fail("No side conversation is open.")
        return
      }
      open(open_.parentID)
      await discard(open_.sessionID)
      mutate((draft) => {
        draft.side = undefined
      })
      ctx.ui.toast.show({
        variant: "info",
        message: config.cleanup ? "Side conversation discarded." : "Returned to the main thread.",
      })
    }

    // `keymap.layer` binds to the calling Solid component, so it has to run
    // inside the host's tree. A zero-output claim on the `app` slot is the
    // documented way in: registering from `setup` fails with
    // "Keymap.Provider is missing".
    const offSlot = ctx.ui.slot({
      append: "app",
      render: () => {
        ctx.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "side.start",
              title: "Start a side conversation",
              description: "Fork the current session into an ephemeral side conversation",
              group: "Session",
              palette: true,
              slash: { name: "side" },
              bind: false,
              enabled: () => !isSide(currentSessionID()),
              run: () => exclusive(start),
            },
            {
              id: "side.toggle",
              title: "Switch between side conversation and parent",
              group: "Session",
              palette: true,
              slash: { name: "sideswitch" },
              bind: config.keybind,
              enabled: () => state.side !== undefined,
              run: toggle,
            },
            {
              id: "side.close",
              title: "Close the side conversation",
              description: "Return to the main thread and discard the ephemeral fork",
              group: "Session",
              palette: true,
              slash: { name: "sideclose" },
              bind: false,
              enabled: () => state.side !== undefined,
              run: () => exclusive(close),
            },
          ],
        }))
        return null
      },
    })


    // Only confirmed deletion invalidates the pointer; the local cache may lag.
    const offRemoved = ctx.data.on("session.deleted", (event) => {
      const id = event.data.sessionID
      const open_ = state.side
      if (!id || !open_) return
      if (id !== open_.sessionID) return
      mutate((draft) => {
        draft.side = undefined
      })
    })

    return async () => {
      disposed = true
      offSlot()
      offRemoved()
      await pending
      // TODO(review): Choose whether reload should retain live forks; cleanup exposes no exit reason.
      const open_ = state.side
      if (!open_ || !config.cleanup) return
      try {
        await discard(open_.sessionID)
        mutate((draft) => { draft.side = undefined })
      } catch {
        fail(`Failed to discard side conversation ${open_.sessionID}. Delete it manually or retry /sideclose.`)
      }
    }
  },
} satisfies Plugin.Definition

export default plugin
