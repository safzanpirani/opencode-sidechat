# opencode-side

Side conversations for opencode v2, cloned from the Codex CLI `/side` command.

`/side` forks the session you are in into an ephemeral copy, opens it in its own tab, and lets you
ask questions or poke around without any of it landing in the main thread. `/sideclose` throws the
fork away and puts you back.

Built on the opencode v2 plugin system: a TUI half that owns the commands and the fork, and a server
half that injects the boundary prompt.

> Targets `@opencode/cli` v2 (`opencode2`). It is not compatible with the older 1.x `opencode`,
> which has a different plugin API.

## Install

Build, then point both of v2's plugin configs at the directory:

```sh
bun install && bun run build
```

Create a plugin directory in your opencode config dir that re-exports the build:

```sh
mkdir -p ~/.config/opencode/side
echo 'export { default } from "/path/to/sideplugin/dist/tui.js"'   > ~/.config/opencode/side/tui.js
echo 'export { default } from "/path/to/sideplugin/dist/index.js"' > ~/.config/opencode/side/index.js
```

Register both halves — they use different config files:

```jsonc
// ~/.config/opencode/cli.json   (TUI plugins)
{ "plugins": ["./side"] }

// ~/.config/opencode/opencode.json   (server plugins)
{ "plugin": ["./side"] }
```

Then `opencode service restart` and start a new TUI. `/plugins` shows whether both halves loaded.

## Commands

| Command | Default key | What it does |
| --- | --- | --- |
| `/side` | — | Fork the current session into a side conversation and open it |
| `/sideswitch` | `<leader>z` (`ctrl+x z`) | Switch between the side conversation and its parent |
| `/sideclose` | — | Return to the parent and discard the fork |

All three also appear in the command palette under `Session`.

## Behaviour

**One at a time.** Inside a side conversation `/side` disappears from slash completion and the
palette, so you cannot nest them. Opening a second one while one is live is refused.

**The main thread has to have started.** Forking an empty session gives you nothing, so `/side`
waits until the parent has at least one message.

**The boundary.** The fork carries the entire main-thread history, which on its own makes the model
resume whatever the main thread was halfway through. The server half appends a system prompt to
every side conversation that reframes the inherited history as reference context, tells the model to
answer questions rather than continue the task, and tells it not to mutate the workspace or touch
subagents unless you explicitly ask.

**Read-only by default.** At fork time the side session gets its own permission ruleset forcing
`edit` (including write and patch), `shell` and `subagent` to prompt, even when the parent session runs
with them allowed. You can still authorise a mutation. MCP and custom tool actions are not covered by this ruleset.

The title prefix and fork parent identify side conversations. Removing the prefix disables the
server boundary prompt; an already tracked TUI fork remains tracked until closed.

**Ephemeral.** Closing the side conversation deletes it, and so does quitting the TUI with one open.
Editing the plugin while a side conversation is open also discards it, because a plugin reload runs
the same cleanup as an exit.

## Configuration

Options go in the tuple form alongside the plugin spec:

```jsonc
{ "plugins": [["./side", { "keybind": "<leader>z", "readonly": "ask", "cleanup": true }]] }
```

| Option | Default | Meaning | Read by |
| --- | --- | --- | --- |
| `keybind` | `"<leader>z"` | Key for `side.toggle` | TUI |
| `cleanup` | `true` | Delete the fork on close; `false` retains it with its side title and permissions | TUI |
| `readonly` | `"ask"` | `"ask"` prompts for mutating actions, `"deny"` blocks them, `"off"` leaves permissions alone | TUI |
| `boundary` | `true` | Inject the side-conversation system prompt | server |

## How it maps onto Codex

| Codex | Here |
| --- | --- |
| `/side` | `/side` |
| `toggle_side_conversation` | `side.toggle` / `/sideswitch` |
| `Ctrl+C` to return and close | `/sideclose` |
| Ephemeral fork of the current thread | `session.fork` plus delete on close |
| Side-conversation boundary item | `session.hook("context")` appending a system part |
| "do not mutate" instruction | The same instruction, plus an enforced permission ruleset |

Two deliberate divergences. Codex states the read-only rule in the prompt only; opencode can enforce
it in the session's permission ruleset, so this does both. And where Codex uses Ctrl+C to return,
this leaves Ctrl+C alone and uses `<leader>z` plus slash commands.

Note that opencode v2 already ships `/btw`, which answers a one-shot question from the session's
context without adding to the conversation. `/side` is the heavier tool: a real forked thread you can
hold a multi-turn conversation in.

## Notes on the v2 plugin API

Two things cost time and are worth recording:

- `keymap.layer()` must be called from inside the host's Solid tree. Calling it directly in `setup`
  fails with `Keymap.Provider is missing`. The way in is a zero-output claim on the `app` slot.
- The layer needs `mode: "global"`. Without it the commands register but never surface in slash
  completion or the palette.
- Both halves export a plain `{ id, setup }` object with type-only imports rather than calling
  `Plugin.define`. That helper is an identity function, but importing it pulls the SDK in at runtime,
  and `@opencode/plugin/tui` reaches for `solid-js`, a peer only the host provides.

## Layout

```
src/shared.ts   marker, boundary prompt, option parsing, permission ruleset
src/tui.ts      commands, the fork, navigation, cleanup
src/index.ts    boundary prompt injection
```
