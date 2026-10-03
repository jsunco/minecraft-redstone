# command centre

`admin_control` exposes the actual Minecraft console and tick manager. It does
not open chat or borrow the player's camera. The helper must be updated and
both the bearer authentication and `max_access: "admin"` must be enabled on the
relevant loopback endpoint. Existing credentials are reused locally.

Start with `{"action":"status"}`. Mutations require the returned session and
the exact world name:

```json
{"action":"tick","operation":"rate","rate":100,"expected_session":"UUID","expected_world":"TinyGPU Workshop"}
```

Tick operations: `rate`, `freeze`, `unfreeze`, `step`, `step_stop`, `sprint`,
`sprint_stop`. Step and sprint require an explicit `ticks` duration. Their
receipt starts the operation; poll status to establish completion. The target
rate is not a measurement of achieved TPS. Active native recordings block
administrative commands so a test cannot silently change its timing model.

Reload resets the target rate to 20 TPS; read status again before an accelerated
run. `server_tick` restarts with the server, while `world_game_time` persists.
Compare elapsed ticks within one clock and session, never their absolute values
across clocks.

Use `action:"command"` and a single `command` string for vanilla commands such
as `forceload query`, `time set day`, gamerules, and `save-all flush`. Commands
have full console authority, report native feedback/errors, and are not
automatically undoable. Prefer the backed-up build tools for construction.

`client_control` has `status`, `options`, `quit`, `create`, and `open` actions.
It uses `expected_session_id` and `expected_world` (the save directory name).
At the title screen these are `"none"` and `""`. `options` accepts render
distance 2–32, simulation distance 5–32, and FPS caps in multiples of ten.
Creation uses a **new** Creative/Peaceful vanilla Void world with commands;
existing saves are refused. `quit` saves before returning to title. Poll
status after lifecycle operations: an accepted request is not a loaded world.

The compact wrapper keeps the shared writer lock until that exact lifecycle
operation reports a terminal state. A completed create/open must also show the
requested save loaded; a completed quit must show no loaded world. Quit refuses
active native recordings and seals admission of new recorders on the server
thread before disconnecting. If its pre-disconnect check fails, that seal is
released on the same server thread. The native endpoint still returns an
asynchronous receipt; the compact wrapper waits for completion.

A lost acknowledgement, status error, or completion timeout leaves the writer
lock in place. This is intentional: the queued operation may still execute.
Status reads remain available. Do not replay the request or clear the lock just
because its owner process exited. For explicit recovery, match the lock's exact
`owner.json` ID to the `lock_owner` in `commands.jsonl`; then obtain a fresh
`client_lifecycle_status` and match its operation ID, action, destination,
`expected_session_id`, and `expected_world` to the recorded request/accepted
receipt. Only a matching `completed` or `failed` operation permits releasing
that same lock after checking the actual loaded-world state. Retain the terminal
receipt and recovery record. If the acknowledgement was lost, the operation ID
must also differ from the recorded `before_operation_id`. An `accepted`,
`loading`, `indeterminate`, mismatched or unavailable receipt is not recovery
evidence. No automatic retry or automatic stale-lock removal is performed.

Rendering and simulation are separate. A low render distance reduces visible
terrain; it cannot selectively draw only an arbitrary construction region.
Use a sparse world and pin only the active circuit chunks with `forceload`.
Preserve those pins for a running integrated GPU. The player still keeps a
small surrounding area loaded.

The CLI uses the same shared writer lock and local journal as MCP:

```sh
npm run admin -- status
npm run admin -- /absolute/path/request.json
```

For a client request add `"target":"client"` to the JSON file. Authentication
tokens never appear in command-line arguments. Journal records live under
`.minecraft-assistant/admin/commands.jsonl`. Transport errors are not retried:
a command may have executed before its connection failed. Inspect live state
before deciding what to do next.
