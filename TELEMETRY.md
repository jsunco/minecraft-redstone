# Optional compact Minecraft telemetry

Implemented 2026-09-27. The adapter is locally tested; actual Minecraft readings remain unverified because the game-side Fabric bridge is not running.

## How it works

Read the same underlying game state that supplies useful debug information, through the bridge's APIs. F3 does not need to be visible and no OCR is needed. Coordinates, dimension, facing, held item and targeted block are available upstream. Inventory and exact redstone properties add information beyond the F3 overlay. Not every F3 diagnostic is exposed by the current bridge.

The local Node process holds each selected watch's last delivered snapshot. It compares new readings locally and sends only additions, changes and removals. A watch can be a player's status, selected inventory, exact output block or small region summary. Raw readings are not added to the assistant conversation. Nothing runs continuously between tool requests.

Modes:

| Mode | Behavior |
|---|---|
| `disabled` | Default. Poll makes no game reads; raw bridge tools remain available. |
| `data` | Structured snapshot/delta/unchanged replies. No images from this service. |
| `hybrid` | Same structured replies plus an explicit `telemetry_view` tool when a picture helps. No automatic screenshot stream. |

The original world/client endpoints remain available for building and exceptional detailed inspection. This mode does not remove their tool schemas or erase context already used. It is an optional read adapter, not a new independent camera.

## Use

After the Fabric bridge is running and the new plugin tools have loaded, ask Codex to enable compact Minecraft mode. A new Codex chat is the reliable boundary for picking up the installed MCP tool changes; project progress files preserve this work.

The service provides five tools: telemetry_status, telemetry_configure, telemetry_source_schema, telemetry_poll, telemetry_view.

First inspect the exact argument schema with telemetry_source_schema for each tool needing arguments. For example, current client_status takes no arguments. An initial configuration is:

```json
{
  "mode": "hybrid",
  "watches": [
    {
      "id": "player",
      "source": "client",
      "tool": "client_status",
      "arguments": {},
      "fields": ["in_game", "dimension", "pos", "yaw", "pitch", "held_item", "held_count"]
    },
    {
      "id": "target",
      "source": "client",
      "tool": "sense_crosshair",
      "arguments": {}
    }
  ],
  "max_text_bytes": 8000,
  "min_poll_ms": 5000
}
```

Then call telemetry_poll after a relevant action. Add a watch for the particular inventory/output block when needed. Do not poll everything merely because it is available. Configure replaces all watches and resets baselines. Selecting `disabled` stops this adapter's reads; it does not disable direct MCP endpoints.

To recover after context compaction or a missed response, call telemetry_poll with `full:true`. Automatic full refresh happens on the next poll after 60 seconds and after read errors; there is no background timer. Sequence numbers expose missed responses. Source failures are reported as unavailable, not unchanged. Oversize readings retain their old baseline and can be retried with narrower fields or larger bounds.

## Data shape and budgets

A snapshot contains `value`. A delta contains `set:[{path,value}]` and `remove:[path]`, using RFC6901 JSON Pointers. Apply removals then sets. An unchanged record confirms only equality at sampling time. Explicit slot inventories normalize to maps; implicit-index inventories keep indices, allowing a single changed item count to be delivered. Values are not additionally rounded. Empty/missing/null fields remain distinct.

Default projection omits bulky NBT/component payloads; explicit fields can request them when needed. Nonexistent selections return unavailable when no selected fields exist. Defaults: eight watches maximum, an 8,000-byte total poll text budget (configurable 2,048–16,000), and five seconds minimum between polls. The interval increases for many watches to budget roughly 40 read calls/minute per endpoint, below upstream's default 60; other tools still share that upstream budget. Rate limits remain possible.

Region summaries are limited to 4,096 blocks by this adapter. They are material histograms, not redstone-state monitors. Use block_get_state for specific output power/lit/powered fields. Broad entity/region scans, mutations, commands and event drains are deliberately outside this adapter; use the appropriate direct bridge tools when the task requires them.

Upstream can return JSON or TOON text rather than structuredContent. The official TOON decoder handles those reads before projection/diffing. Structured inputs are capped at 2 MB after the SDK delivers the response. This is not a network-stream memory cap. The model-facing output cap is enforced separately. Default omission and oversize errors are explicit in this workflow; no false claim of complete inventory/world coverage is made.

## Pictures

Only hybrid mode permits telemetry_view. Default downscale=4, allowed range 2–8; 30-second cooldown; one returned image capped at 512 KB decoded. The adapter always sets close_screen=false, preserving the user's inventory/menu. Oversized images require a more reduced explicit retry. Cropping is not implemented.

The current endpoint sees the user's local client. It is not an independent observer; a separate observer renderer is still outstanding. Images are not sent for routine state reads. Visual inspection remains useful for orientation, layout mistakes and final demonstration.

## Limits and cost measurement

Ordinary polling can miss short pulses, and multiple tool reads are not an atomic tick snapshot. Reliable redstone waveforms require a tick-level recorder inside the game. Existing event callbacks do not cover all redstone/inventory changes, and the upstream event queue can lose entries. This adapter compares actual reads instead of assuming a reliable event stream.

telemetry_status exposes source payload bytes and delivered text bytes for polls, plus screenshots sent. These are payload measurements, not token billing, model cost, account rate-limit usage, or a promised percentage saving. Actual savings require comparable live tasks. Tool descriptions and earlier conversation still consume context.

## Local implementation and tests

Run from this repository's root:

```sh
npm ci --ignore-scripts
npm run configure:local
npm test
```

Node 22+ is required. Exact dependency versions and integrity hashes are locked in package-lock.json. Local setup generates an ignored .mcp.json with the Node executable and checkout path; rerun it after moving the checkout. The adapter listens on stdio, opens no network listening port, and uses fixed localhost game endpoints. See README.md for installation.

24 tests passed: delta correctness, slot changes/deletion, null/missing, Unicode byte budgets, oversize baseline retention, prototype safety, parsing real upstream-shaped TOON, read-only allowlist, small budgets/eight watches, reconnection, image controls, real SDK stdio handshake, and mock HTTP MCP exchange. A real connection probe returned unavailable/fetch failed because the client bridge is absent. No live game result or savings measurement has been established.

Sources: [upstream tools](https://github.com/chapmanjw/minecraft-java-fabric-mcp-server/blob/main/docs/tools.md), [actual event wiring](https://github.com/chapmanjw/minecraft-java-fabric-mcp-server/blob/main/src/main/java/com/chapmanjw/minecraft/fabric/mcp/tools/events/EventWiring.java), [TOON tool results](https://github.com/chapmanjw/minecraft-java-fabric-mcp-server/blob/main/src/main/java/com/chapmanjw/minecraft/fabric/mcp/protocol/ToolResult.java), [official MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk), [TOON decoder](https://github.com/toon-format/toon).
