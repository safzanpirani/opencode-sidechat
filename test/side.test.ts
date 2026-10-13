import { describe, expect, test } from "bun:test"
import server from "../src/index.js"
import tui from "../src/tui.js"
import { guardRuleset, isSideSession, SIDE_SYSTEM_PROMPT, sideIdentity } from "../src/shared.js"
import type { Plugin as ServerPlugin } from "@opencode/plugin"
import type { Plugin as TuiPlugin } from "@opencode/plugin/tui"

type Rule = { action: string; resource: string; effect: "deny" | "ask" | "allow" }
type SessionRecord = { id: string; title?: string; fork?: { sessionID: string }; permissions?: Rule[] }
type State = { side?: { sessionID: string; parentID: string }; busy?: boolean }
type Route = { type: string; sessionID: string }
type Command = { id: string; run: () => Promise<void> | void; enabled: () => boolean }
type ContextInput = { sessionID: string; system: { type: "text"; text: string }[] }
type PermissionInput = { sessionID: string; effect: string }
type ContextHook = (input: ContextInput) => Promise<void>
type PermissionHook = (input: PermissionInput) => Promise<void>

function host(options: Record<string, unknown> = {}) {
  const state: State = {}
  const sessions = new Map<string, SessionRecord>([["main", { id: "main", title: "Main" }]])
  let route: Route = { type: "session", sessionID: "main" }
  let commands: Command[] = []
  const calls: string[] = []
  const fixture = {
    options,
    storage: { memory: () => [state, (mutate: (draft: State) => void) => mutate(state)] },
    data: { session: { get: (id: string) => sessions.get(id) }, on: () => () => {} },
    ui: {
      router: { current: () => route, navigate: (next: Route) => { route = next } },
      dialog: { clear() {} }, toast: { show() {} },
      slot: (claim: { render: () => unknown }) => { claim.render(); return () => {} },
    },
    keymap: { layer: (layer: () => { commands: Command[] }) => { commands = layer().commands }, shortcuts: () => [] },
    client: {
      message: { list: async () => ({ data: [{}] }) },
      session: {
        fork: async () => {
          const side: SessionRecord = { id: "side", fork: { sessionID: "main" }, permissions: [{ action: "custom.delete", resource: "*", effect: "deny" }] }
          sessions.set(side.id, side)
          return side
        },
        update: async ({ sessionID, ...update }: { sessionID: string; title?: string; permissions?: Rule[] }) => { Object.assign(sessions.get(sessionID)!, update) },
        interrupt: async (input: { sessionID: string }) => { calls.push(`interrupt:${input.sessionID}`) },
        remove: async (input: { sessionID: string }) => { calls.push(`remove:${input.sessionID}`); sessions.delete(input.sessionID) },
      },
    },
  }
  // Only the host methods exercised by this regression are implemented locally.
  const ctx = fixture as unknown as TuiPlugin.Context
  return {
    ctx, state, sessions, calls,
    command: (id: string) => commands.find((command) => command.id === id)!,
    navigate: (id: string) => { route = { type: "session", sessionID: id } },
    current: () => route.sessionID,
  }
}

async function serverHooks(get: () => Promise<unknown>, options = {}) {
  const hooks = {} as { context: ContextHook; permission: PermissionHook }
  const fixture = {
    options,
    session: { get, hook: async (_: string, callback: ContextHook) => { hooks.context = callback; return { dispose: async () => {} } } },
    permission: { hook: async (_: string, callback: PermissionHook) => { hooks.permission = callback; return { dispose: async () => {} } } },
  }
  // The SDK host is external; only lookup and hook registration are needed here.
  const ctx = fixture as unknown as ServerPlugin.Context
  await server.setup(ctx)
  return hooks
}

describe("side boundary and lifecycle", () => {
  test("renames preserve the boundary, ordinary and inherited forks do not gain it", async () => {
    const side = { id: "side", title: "Renamed", fork: { sessionID: "main" }, permissions: [sideIdentity("side", "main")] }
    expect(isSideSession(side)).toBe(true)
    expect(isSideSession({ ...side, id: "another-fork" })).toBe(false)
    expect(isSideSession({ ...side, fork: undefined })).toBe(false)
    expect(isSideSession({ title: "⑂ side · Main", fork: { sessionID: "main" } })).toBe(false)
    const hooks = await serverHooks(async () => side)
    const input = { sessionID: "side", system: [] }
    await hooks.context(input)
    expect(input.system).toEqual([{ type: "text", text: SIDE_SYSTEM_PROMPT }])
  })

  test("lookup rejection and missing records keep the boundary and deny actions", async () => {
    for (const get of [async () => { throw new Error("unavailable") }, async () => undefined]) {
      const hooks = await serverHooks(get)
      const context = { sessionID: "side", system: [] }
      const permission = { sessionID: "side", action: "custom.delete", effect: "allow" }
      await hooks.context(context)
      await hooks.permission(permission)
      expect(context.system).toHaveLength(1)
      expect(permission.effect).toBe("deny")
    }
  })

  test("ordinary sessions and explicit opt-outs are unchanged", async () => {
    const hooks = await serverHooks(async () => ({ id: "main" }))
    const context = { sessionID: "main", system: [] }
    const permission = { sessionID: "main", effect: "allow" }
    await hooks.context(context)
    await hooks.permission(permission)
    expect(context.system).toHaveLength(0)
    expect(permission.effect).toBe("allow")
    expect(await serverHooks(async () => undefined, { boundary: false, readonly: "off" })).toEqual({})
  })

  test("wildcard guards cover unknown actions in ask and deny modes", () => {
    expect(guardRuleset("ask")).toEqual([{ action: "*", resource: "*", effect: "ask" }])
    expect(guardRuleset("deny")).toEqual([{ action: "*", resource: "*", effect: "deny" }])
    expect(guardRuleset("off")).toBeUndefined()
  })

  test("reload and exit retain forks; explicit close deletes, including after restart", async () => {
    const h = host()
    const dispose = tui.setup(h.ctx)
    await h.command("side.start").run()
    const side = h.sessions.get("side")
    expect(isSideSession(side)).toBe(true)
    expect(side.permissions).toContainEqual({ action: "custom.delete", resource: "*", effect: "deny" })
    await dispose()
    expect(h.calls).toEqual([])
    const disposeReload = tui.setup(h.ctx)
    h.command("side.toggle").run()
    expect(h.current()).toBe("main")
    h.command("side.toggle").run()
    expect(h.current()).toBe("side")
    await disposeReload()
    delete h.state.side // A TUI restart loses memory, but not the session marker.
    const disposeRestart = tui.setup(h.ctx)
    expect(h.command("side.close").enabled()).toBe(true)
    await h.command("side.close").run()
    expect(h.current()).toBe("main")
    expect(h.calls).toEqual(["interrupt:side", "remove:side"])
    await disposeRestart()
  })

  test("disposal during configuration waits without deleting or navigating", async () => {
    const h = host()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const update = h.ctx.client.session.update
    h.ctx.client.session.update = async (input) => { await gate; await update(input) }
    const dispose = tui.setup(h.ctx)
    const start = h.command("side.start").run()
    const cleanup = dispose()
    release()
    await Promise.all([start, cleanup])
    expect(isSideSession(h.sessions.get("side"))).toBe(true)
    expect(h.state.busy).toBe(false)
    expect(h.current()).toBe("main")
    expect(h.calls).toEqual([])
  })

  test("off and cleanup false retain inherited policy and durable identity", async () => {
    const h = host({ readonly: "off", cleanup: false })
    const dispose = tui.setup(h.ctx)
    await h.command("side.start").run()
    const side = h.sessions.get("side")
    expect(isSideSession(side)).toBe(true)
    expect(side.permissions).toEqual([
      { action: "custom.delete", resource: "*", effect: "deny" },
      sideIdentity("side", "main"),
    ])
    await h.command("side.close").run()
    expect(h.calls).toEqual(["interrupt:side"])
    expect(isSideSession(h.sessions.get("side"))).toBe(true)
    await dispose()
  })

  test("configuration failure removes the unguarded fork even with cleanup disabled", async () => {
    const h = host({ cleanup: false })
    h.ctx.client.session.update = async () => { throw new Error("update failed") }
    const dispose = tui.setup(h.ctx)
    await h.command("side.start").run()
    expect(h.calls).toEqual(["remove:side"])
    expect(h.current()).toBe("main")
    expect(h.state.side).toBeUndefined()
    await dispose()
  })
})
