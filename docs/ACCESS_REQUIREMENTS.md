# Minecraft access requirements

Updated: 2026-09-27

the user requires broad inspection and independent movement: "see inventories, see my position, see everything, move independently from my body". The access layer is a development tool for the vanilla-redstone learning project. Installing an MCP configuration is not implementation or verification of these capabilities.

## Acceptance contract

| Capability | Required behavior | Existing bridge / gap |
|---|---|---|
| Player state | Inspect the user's dimension, coordinates, yaw/pitch, health, game mode and current held item without moving him. | Player/client inspection exists; verify exact fields in the running tool schemas. |
| Inventories | Inspect slot numbers, item IDs, counts and available metadata for player inventory, hotbar, equipment, Ender Chest, storage blocks and supported inventory entities without opening the user's GUI. | Player and generic Container reads exist. No dedicated Ender Chest/equipment adapter was found; these require explicit coverage. Item summaries expose component names, not their values. |
| World inspection | Query blocks, state properties, block entities, entities and bounded regions; identify missing/unloaded data explicitly. | Broad server tools exist. Validate actual adapters and region/chunk limits. |
| Independent observer | Maintain assistant position, dimension and orientation independently of the user. Fly or relocate to inspect a circuit without changing the user's body, aim, game mode, selected slot or GUI. | Not supplied by upstream's client screenshot tools. Custom observer/rendering or a separate rendered client is required. |
| Observer screenshots | Return a real Minecraft-rendered frame from the assistant viewpoint, tagged with camera pose and capture state. the user's view remains usable. | Existing view_capture captures the local player's current frame. It does not establish a second viewpoint. |
| Distant inspection | Inspect requested project regions away from the user. Report chunk/render availability and load only bounded regions needed for a request. | A detached camera alone does not ensure remote chunks are loaded, sent or rendered. Must implement and test this explicitly. |
| Construction | Place, break, clone and restore vanilla blocks in the project area; operate circuit inputs; inspect results. | World commands and block tools exist. Semantics and redstone settling require in-game validation. |
| Time and events | Observe relevant world changes and distinguish server ticks, paused state and stale snapshots. | Events/status tools exist; a reliable wait-for-tick and capture sequence must be verified. |

"See everything" means broad, queryable game state in the user's project world. It does not mean one giant snapshot of an infinite world, awareness of ungenerated terrain, or access to other servers without their permission. Region/inventory queries should be bounded and paginated where necessary; unavailable information must never be fabricated.

## Implementation direction

Reuse the Fabric bridge for structured world/player/inventory access. Add an assistant observer with independent pose and a real rendered capture. The implementation choice is still open between a dedicated render view in the client and a separate rendered observer client. A single-client freecam that takes over the user's screen does not satisfy simultaneous independent play. A server-side fake entity by itself cannot produce a real screenshot.

A visible second player and autonomous survival/pathfinding are possible additional designs but are not assumed requirements of this redstone-building request. Independent fly/relocate/view and world-tool interaction are the required baseline. Do not silently require a second paid account or weaken server authentication for setup.

The existing block_render_region is useful for a map/diagram at arbitrary coordinates, but it is not a substitute for the requested real independent viewpoint. Upstream player_set_camera uses vanilla spectate semantics and must not be used to commandeer the user's camera.

The independent observer is a missing feature on the supported upstream versions too. Choosing 26.2 reduces compatibility work; it does not make this requirement complete. Game-side setup must choose a supported version or port the bridge to the desired version. Preserve the existing world in either case.

## Source-level gaps to carry into implementation

The players category is disabled in the default upstream configuration. Enable it when setting up the project bridge while preserving the other needed categories; a category allowlist replaces defaults. General inventory tools are in the items category. This is a game-side configuration task still pending installation.

The inspected inventory adapter iterates the player's Inventory or a Minecraft Container/InventoryCarrier. It has no distinct Ender Chest or equipment endpoint. Item conversion reports IDs/counts/component names and durability, not all component values. Full inventory coverage needs named stores, accurate slot mapping and richer item data; NBT reads can help where supported but do not establish uniform coverage automatically.

Current raycast and nearby-entity sensing use the local player position, so an observer implementation must give these tools an explicit observer origin too. Changing only the screenshot camera would leave perception inconsistent.

A separate rendered Minecraft client/player is the strongest reuse path: point the agent screenshot tools at that client's endpoint and move only its explicitly identified player. That requires checking local session identity/authentication and performance. Teleport/fly-style repositioning is distinct from autonomous walking/pathfinding. A custom offscreen renderer in one client avoids a second player but needs render-thread/camera/raycast/chunk work. Neither route is implemented yet.

## Operational rules applied now

The installed plugin skill must separate the user player identity from any assistant identity. Read inventories through data tools. Never teleport or change the user's game mode/camera to implement independent movement. Do not send in-game chat on the user's behalf without explicit instructions.

Upstream view_capture defaults to close_screen=true, which can dismiss the user's open inventory or menu. When inspecting the user's client, explicitly use close_screen=false unless he requests changing the screen. If that prevents a clean frame, report the limitation; do not take over his UI. The independently rendered observer should avoid this problem by design.

## Required integration checks

1. Read user position, direction and inventory while the user can continue playing; compare representative slot contents with the game's inventory.
2. Read a populated chest and an empty container at known coordinates without opening or dismissing the user's GUI. Check one supported inventory entity and available item metadata.
3. Record user state and observer state. Move/rotate the observer, capture from two locations, and confirm the user pose, mode, selected slot and GUI did not change because of those commands. Repeat while the user moves normally.
4. Aim the observer at a known redstone circuit. Capture its visible lamp and read its exact state; test off/on/off while server ticks advance.
5. Move the observer beyond the user's nearby chunks. Verify actual loaded/rendered data or return an explicit availability result. No stale screenshot may be described as current.
6. Reconnect/restart, enter a menu, change dimension and close the world. Ensure observer state is reset or marked invalid, with no unintended user teleport/camera change.
7. Run the finished redstone computer in unmodified Minecraft using a preserved copy of the world.

These are acceptance tests, not completed results. No game-side helper or independent observer is installed or verified yet.

## Evidence

- [Upstream tool reference](https://github.com/chapmanjw/minecraft-java-fabric-mcp-server/blob/main/docs/tools.md): player_get_inventory, inventory_get, player_get_info, client_status, world/block/entity tools, player_set_camera, and the client inspection-only scope.
- [Upstream README](https://github.com/chapmanjw/minecraft-java-fabric-mcp-server): separate world/client endpoints and version matrix.
- [Access setup](../README.md): installed Codex wrapper, pending game-side setup and version decision.

Additional primary-source checks: [player adapter](https://github.com/chapmanjw/minecraft-java-fabric-mcp-server/blob/main/src/main/java/com/chapmanjw/minecraft/fabric/mcp/adapter/impl/PlayerOps.java), [entity/inventory adapter](https://github.com/chapmanjw/minecraft-java-fabric-mcp-server/blob/main/src/main/java/com/chapmanjw/minecraft/fabric/mcp/adapter/impl/EntityOps.java), [client implementation](https://github.com/chapmanjw/minecraft-java-fabric-mcp-server/blob/main/src/client/java/com/chapmanjw/minecraft/fabric/mcp/adapter/client/ClientAccessImpl.java), [item conversion](https://github.com/chapmanjw/minecraft-java-fabric-mcp-server/blob/main/src/main/java/com/chapmanjw/minecraft/fabric/mcp/adapter/impl/AdapterContext.java), [category configuration](https://github.com/chapmanjw/minecraft-java-fabric-mcp-server/blob/main/docs/configuration.md).
