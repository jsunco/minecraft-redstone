# Independent observer

`observer_control` operates a **separate rendered spectator client**, with client MCP on `127.0.0.1:8767`. The user's client stays on port 8766; the shared world endpoint uses port 8765. This reuses Minecraft rendering while keeping user controls separate.

Requires a distinct authenticated player already connected to the same world and in spectator mode. The plugin does not launch a second account, alter authentication, host LAN, buy an account or change game mode. A single-client offscreen renderer is not implemented. Until the separate client exists, independent pictures are unavailable; structured world inspection still works.

Configure that separate client's `config/minecraft_fabric_mcp/client.json` with loopback host `127.0.0.1`, port `8767`, `allow_remote: false`, and `auth_required: true`. Supply a fresh local bearer token. Set `MINECRAFT_OBSERVER_CONFIG` to the absolute path of that file for the assistant runner. Do not reuse or print the user's client token. The main installation helper configures only ports 8765 and 8766.

Use live `client_status` and player data to identify UUIDs, then call `observer_control`:

```json
{"action":"attach","user_uuid":"<user UUID>","observer_uuid":"<distinct spectator UUID>"}
```

The service checks both identities, online spectator status, and agreement of observer client/server position and dimension. It rechecks before moving or capturing. `move` takes a dimension, position, and optional facing point; only the observer UUID is targeted. Position is read back. Capture requires the client to reach the requested pose. A screenshot does not establish complete chunk rendering.

`capture` returns a downscaled image, timestamp, and observer pose while preserving the GUI. It defaults to `downscale: 4`, with a 512 KB decoded size cap and a 30-second cooldown after successful capture. `status` inspects the binding; `detach` clears it without world changes. Restart requires reattachment.

No automatic fallback moves or captures the user. Explicit hybrid `telemetry_view` can show the user's viewpoint. Region-map images are diagrams, not independent rendered screenshots.

Runtime acceptance still needed: record user pose/mode/slot/GUI; move observer to two locations, capture and confirm no commanded user changes; repeat while user moves, after dimension changes/reconnect/world closure and in distant chunks. Automated controller tests use simulated endpoints.
