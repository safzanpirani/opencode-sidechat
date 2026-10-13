import type { Plugin } from "@opencode/plugin"
import { PLUGIN_ID, SIDE_SYSTEM_PROMPT, isSideSession, resolveOptions } from "./shared.js"

/**
 * Server half of the side-conversation plugin.
 *
 * Its job is the boundary. A side conversation is a fork, so it inherits the
 * entire main thread; without an explicit system prompt the model simply
 * resumes whatever the main thread was in the middle of. Read-only enforcement
 * lives on the session's own permission ruleset, which the TUI half sets at
 * fork time.
 */
/** Plain object for the same reason as the TUI half: no runtime SDK import. */
const plugin = {
  id: PLUGIN_ID,
  async setup(ctx) {
    const config = resolveOptions(ctx.options)

    // If identity cannot be checked, keep the boundary and deny permissions
    // rather than relying on whether the host propagates a rejected hook.
    const registration = config.boundary ? await ctx.session.hook("context", async (input) => {
      const session = await ctx.session.get({ sessionID: input.sessionID }).catch(() => undefined)
      if (session && !isSideSession(session)) return
      input.system.push({ type: "text", text: SIDE_SYSTEM_PROMPT })
    }) : undefined
    const permission = config.readonly !== "off" ? await ctx.permission.hook("evaluate", async (input) => {
      const session = await ctx.session.get({ sessionID: input.sessionID }).catch(() => undefined)
      if (session) return
      input.effect = "deny"
      input.message = "Cannot verify the side-conversation boundary. Retry when session lookup is available."
    }) : undefined

    return async () => {
      await permission?.dispose()
      await registration?.dispose()
    }
  },
} satisfies Plugin.Plugin

export default plugin
