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
    if (!config.boundary) return

    // Looked up per request rather than cached: the marker is written by a
    // different process moments after the fork, and a local RPC is cheaper
    // than reasoning about when a cached "not a side conversation" went stale.
    const registration = await ctx.session.hook("context", async (input) => {
      // TODO(review): Verify hook-error behavior before choosing fail-closed lookup handling.
      const session = await ctx.session.get({ sessionID: input.sessionID }).catch(() => undefined)
      if (!isSideSession(session)) return
      input.system.push({ type: "text", text: SIDE_SYSTEM_PROMPT })
    })

    return () => registration.dispose()
  },
} satisfies Plugin.Plugin

export default plugin
