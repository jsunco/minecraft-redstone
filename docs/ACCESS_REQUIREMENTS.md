# Minecraft access acceptance

The user requires inventories, player/world state and an assistant viewpoint/movement independent of their body. The tools are development aids; the finished machine must use vanilla blocks and actual redstone.

## Current implementation versus runtime evidence

| Capability | Implemented path | Runtime acceptance still needed |
|---|---|---|
| Player state | `client_status` includes player UUID; `player_get_info` exposes mode/pose/health | Compare live user identity and position |
| Inventory | `player_get_inventory_views` batches 36 main slots, 27 Ender Chest slots, and named equipment; generic container reads are retained | Compare populated/empty slots and storage blocks/entities; metadata availability |
| Exact blocks | Native batches of up to 512 positions in the same server task, with session/tick and explicit availability | Compare known power/lit properties and unloaded positions |
| Construction | Bounded plans, preview, disk backup, batch/fill/clone, readback, conflict-aware undo | Place/undo in an empty test lab and confirm preservation |
| Timing | End-of-server-tick recorder with finite duration, sequence cursors, bounded buffer and explicit gap recovery | Observe actual off/on/off pulses, pause/reconnect behavior |
| Observer | Controller for distinct spectator client, validated UUID/mode/pose and reduced screenshots | Separate authenticated rendered client required; two viewpoints not yet tested |

The 26.3 Java sources compile and automated tests exercise game/protocol contracts with controlled fixtures. There has been no completed live-world acceptance run. Compiled artifacts and staged installation files alone do not establish working runtime behavior. The remaining setup step is to publish the new launcher profile after all Minecraft Launcher instances are closed; see [setup](MINECRAFT_SETUP.md).

## Independent observer constraints

A separate rendered client is the chosen reuse route. The controller cannot create an authenticated second player or offscreen render in one client. Do not weaken authentication or silently require purchase of an account. If no separate client is present, report independent pictures as unavailable while continuing structured world work.

The user's body/camera/mode/slot/GUI must remain independently usable. Never use `player_set_camera` or teleport the user to fake this capability. User screenshots are explicit and preserve the GUI; region map renders are diagrams.

## Verification sequence

1. Read the intended world/session and user UUID, pose and inventories while the user can keep playing.
2. Compare populated and empty player/container slots; check Ender Chest, equipment and one supported inventory entity. Component names do not establish all metadata values.
3. Preview/apply/verify/undo a tiny build in an inspected lab. Compare exact blocks, including preserved air.
4. Record a lever/dust/lamp off/on/off test while server ticks advance; compare waveform/state and rendered image.
5. Attach a distinct spectator client. Capture from two locations, checking user state was not changed by commands. Repeat while the user moves.
6. Check chunk availability far from the user; do not claim unseen terrain is loaded or a screenshot is complete.
7. Exercise world closure, reconnect, dimension changes and paused menus; stale sessions must not mutate a new world.
8. Run the completed redstone computer in vanilla Minecraft using a preserved copy.

“See everything” means broad queryable state in bounded regions, not one snapshot of an infinite world or fabricated unavailable data. Read the live schemas and return explicit limits.

Source/provenance: [upstream](https://github.com/chapmanjw/minecraft-java-fabric-mcp-server), vendored fork under `bridge/vendor`, [setup](MINECRAFT_SETUP.md), [observer](OBSERVER.md).
