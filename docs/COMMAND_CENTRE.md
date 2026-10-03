# command centre

`admin_control` uses the native console and tick manager without player chat or camera movement. It requires the updated helper, bearer authentication and `max_access: "admin"` on the relevant loopback endpoint.

Read `{"action":"status"}` first. Writes require the exact returned session and world:

```json
{"action":"tick","operation":"rate","rate":100,"expected_session":"UUID","expected_world":"World name"}
```

Tick operations: `rate`, `freeze`, `unfreeze`, `step`, `step_stop`, `sprint`, `sprint_stop`. Step/sprint need an explicit `ticks` duration; poll status for completion. Active native recordings block administrative writes.

Reload resets the target rate to 20 TPS. `server_tick` restarts with the server; `world_game_time` persists. Compare ticks within one clock/session. Configured TPS is not measured throughput.

`action: "command"` accepts one vanilla `command`, such as `forceload query` or `save-all flush`. It has full console authority and is not automatically undoable. Prefer [backed-up builds](BUILD_TOOLS.md) for construction. Low render distance does not replace ticking coverage for a distant circuit; preserve required chunk pins.

## client

`client_control` supports `status`, `options`, `quit`, `create` and `open`. Writes require `expected_session_id` and `expected_world` (the save directory name). At title, these are `"none"` and `""`.

Options accept render distance 2–32, simulation distance 5–32 and FPS caps in multiples of ten. Create/open require title state. Create makes a new Creative/Peaceful vanilla Void world with commands and refuses overwrite. Quit saves the world and refuses active recorders. A receipt alone is not a loaded or closed world.

The wrapper holds the shared writer lock until the matching lifecycle operation is terminal and loaded-world state agrees. An unknown outcome retains the lock; status remains readable. Never retry an ambiguous write or clear its lock just because the process exited.

For recovery, match `owner.json` to `lock_owner` in `commands.jsonl`. A fresh `client_lifecycle_status` must match the recorded operation ID, action, destination, expected session and world, and report `completed` or `failed`. Confirm the actual loaded world, retain the receipt, then release only that exact lock. If the acknowledgement was lost, the operation ID must differ from `before_operation_id`. Loading, unavailable or mismatched status is not recovery evidence.

## cli

```sh
npm run admin -- status
npm run admin -- /absolute/path/request.json
```

Add `"target":"client"` for a client request. The CLI shares MCP's writer lock and journal at `.minecraft-assistant/admin/commands.jsonl`. Tokens are read locally, never passed as command-line arguments. After a transport error, inspect state before deciding what to do next.
