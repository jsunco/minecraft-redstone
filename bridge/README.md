# Minecraft 26.3 native bridge

This is a local downstream build of [John Chapman's Minecraft Java Fabric MCP server](https://github.com/chapmanjw/minecraft-java-fabric-mcp-server), pinned to `e2d571ca087ee26fadc431319d2632ce677d88da`. The complete source and MIT license are in `vendor/`; provenance is in `UPSTREAM.json`. There is no nested Git checkout.

The upstream release matrix ended at 26.2. This fork adds an explicit **26.3** target using Java 25, Fabric Loader **0.19.5**, Fabric API **0.161.0+26.3**, and Loom **1.18.2**. These are actual downloaded artifacts, not an assumed version match. The resulting JAR declares Minecraft `26.3` exactly.

## Build and verification

Set `JAVA_HOME` to a JDK 25 installation, then run:

```sh
./bridge/build.sh
```

The wrapper compiles server and client source, runs the Java test suite, and writes `bridge/artifacts/minecraft-fabric-mcp-1.1.0-redstone.1+26.3.jar` plus its SHA-256 file. Downloads, Gradle caches, generated source/build outputs, game directories, and binaries are ignored. It does not install anything into a Minecraft profile or launch Minecraft.

Gradle caches default to `~/.cache/minecraft-redstone` (or `XDG_CACHE_HOME` / explicit `MINECRAFT_BRIDGE_CACHE`) outside the plugin tree, keeping plugin reinstalls from copying hundreds of megabytes of downloaded build dependencies. `GRADLE_USER_HOME` can still override the dependency cache location.

On 2026-09-27 the 26.3 target compiled and **449 JUnit tests passed**, including nine added recorder/native response tests. These test exact values, single-read batch orchestration, session identity separation, thread checks, cursor retries, buffer overflow recovery, unloaded/reloaded states, duration, and stop/discard lifecycle. The native response tests use a controlled world-read seam. A subsequent focused review passed all 11 native/recorder tests, including two additional regressions for active-point/retained-log limits and unchanged-tick duration handling. **No real Minecraft execution or rendering has yet been verified.** Upstream formatting/checkstyle tasks and the other version targets were not part of this verification.

`run-isolated-server.sh` prepares a separate development world beneath `vendor/versions/26.3/run/server`, with Minecraft bound to `127.0.0.1:25576` and authenticated MCP on `127.0.0.1:8775`. It refuses to launch unless the operator has independently provided an accepted `eula.txt`. It does not write acceptance or modify a launcher profile. That runtime test has not been run. The upstream GameTest scaffolding remains unverified and is not wired into this fork's build.

## Native tools

All new game reads are scheduled through the existing Minecraft server-thread executor. The batch and inventory views are one uninterrupted server task, not several network calls. A batch therefore observes one server tick but is not necessarily the end-of-tick state. The recorder samples at `END_SERVER_TICK`.

`server_get_status` additionally returns `session_id`, a fresh UUID for each server/world lifecycle. Every native response carries the same ID and `server_tick`. Do not apply a saved plan against another session.

### Block batch

`block_get_states_batch` input:

```json
{"dimension":"minecraft:overworld","positions":[{"x":0,"y":64,"z":0}],"properties":["power","powered"]}
```

1–512 integer positions; optional `properties` contains at most 16 names, and absent/empty means all state properties. X/Z are bounded to ±30,000,000. Response:

```json
{"session_id":"...","server_tick":100,"dimension":"minecraft:overworld","atomic":true,"phase":"server_task","positions":[{"x":0,"y":64,"z":0}],"states":[{"index":0,"position":{"x":0,"y":64,"z":0},"status":"loaded","id":"minecraft:redstone_wire","properties":{"power":"15"}}]}
```

State rows have `index`, `position`, `status`, and `properties`. `id` exists only for loaded blocks. Status is `loaded`, `unloaded`, `unknown_dimension`, or `outside_build_height`. Invalid dimension identifier syntax is an input error. Reads never force chunks to load. Properties use Minecraft's canonical serialized strings; no rounding, NBT, light query, or invented air for missing chunks.

### Tick recorder

- `block_watch_start`: same dimension/positions/properties as batch, but 1–64 points; `duration_ticks` 1–12000 (default 200); `buffer_capacity` 16–4096 (default 1024). At most 8 retained recorders and 256 active points per server.
- Start response adds `watch_id`, `active`, `started_tick`, `last_sample_tick`, `duration_ticks`, `point_count`, ordered `positions`, complete `initial_states`, `next_seq:0`, `initial_phase:"server_task"`, `sampling_phase:"end_server_tick"`.
- `block_watch_poll`: `{watch_id,after_seq?:0,max_entries?:128}`; max entries 1–512. Poll is non-destructive and retryable with the same cursor.
- Each `entries` item is `{seq,tick,missed_ticks,states:[changed rows]}`. It records changed block IDs, selected properties, and load status; unchanged ticks consume no entries. `last_sample_tick` still advances on unchanged ticks.
- Poll also has `next_seq`, `latest_seq`, `oldest_seq`, `gap`, `dropped_total`, and recorder/session metadata. A buffer overflow returns `gap:true`, **no deltas**, complete `recovery_states` and `recovery_tick`, and resets `next_seq` to the latest sequence. Consumers must reset their baseline and mark the trace incomplete.
- A skipped sampling tick emits an entry with positive `missed_ticks`, even without changed states. Duration counts server ticks, not wall time. A paused integrated server does not advance a trace. `end_reason` is `duration_reached`, `stopped`, or `clock_reset`.
- `block_watch_stop`: `{watch_id,discard?:false}`. Stop preserves the log unless `discard:true` releases it. `block_watch_list` lists retained metadata.

This captures tick-boundary changes produced by redstone updates; it does not depend on player block-placement events. It cannot capture every transition **within one tick**, infer update ordering, or promise all chunks are actively simulated. A reconnect can resume from a cursor within the same running server session; a server/world restart destroys recorders and changes `session_id`.

### Inventory views and observer identity

`player_get_inventory_views` accepts `{uuid,include_component_names?:false}`. It returns an atomic, session-tagged snapshot with `player_uuid`, `status:online|offline`; online results include `player_name`, `selected_slot`, `main:{size,slots}`, `ender_chest:{size,slots}`, and `equipment` keyed by `mainhand`, `offhand`, `feet`, `legs`, `chest`, `head`, `body`, and `saddle`. Main slots are the 36 non-equipment slots; ender storage is normally 27. Slot dictionaries use numeric string keys, including empty slots. Mainhand is an alias of the selected main slot, so do not double-count it.

Each item has `{empty,id,count}` plus `max_count` for occupied slots, damage fields when applicable, and optionally component names. No full component/NBT payload is returned. Offline players' saved files are not read. The tool belongs to the opt-in `players` category. Existing upstream container and player tools remain available.

`client_status` now includes `player_uuid` alongside `player_name`. This allows the local gateway to verify a second observer client's identity before moving its separate player. This fork does **not** add independent rendering or a detached camera. Upstream `view_capture` captures the client that owns its endpoint; a separate observer viewpoint needs a separately connected client/player.

## 26.3 port changes and limitations

- Adapted structure-template manager, recipe-display context, and resource-condition registry lookup APIs to the actual 26.3 classes.
- Disabled `content_registry_get_fuel`, `content_registry_is_compostable`, and `content_registry_set_compostable` on 26.3. Fuel/compost data changed to contextual item components; returning the previous static values would be misleading. These legacy tools retain their older-version source branches.
- The build itself adds no custom blocks or live computation backend. Tools inspect/edit the game; the intended redstone computer must still calculate in ordinary Minecraft.
- The original source's other version targets are retained but not revalidated in this downstream change.
- Inherited generic-event limitation: upstream `EventWiring.install` registers persistent Fabric listeners on each world start without unregistering the previous event bus. Reopening worlds within one client process can retain old generic-event listeners/buffers. Compact state polling and the native tick recorder do not use those listeners; native recorders are cleared per world lifecycle. Generic-event long-session robustness has not been established.

Configuration is `<gameDir>/config/minecraft_fabric_mcp/config.json` and `client.json`. Keep `host:"127.0.0.1"`, `allow_remote:false`, `auth_required:true`, and a locally generated `bearer_token`. Use `included_categories` to expose the required tools; `players` is opt-in. The upstream null-token generator prints a generated token once, so supply one via a private configuration file. No credential belongs in this repository.

Primary compatibility sources: [Fabric Loader 26.3 metadata](https://meta.fabricmc.net/v2/versions/loader/26.3), [Fabric API release metadata](https://api.modrinth.com/v2/project/P7dR8mSH/version?game_versions=%5B%2226.3%22%5D), [Fabric Loom Maven metadata](https://maven.fabricmc.net/net/fabricmc/fabric-loom/maven-metadata.xml), and [Fabric automated testing documentation](https://docs.fabricmc.net/develop/automatic-testing). The compatibility edits were also checked with `javap` against the downloaded 26.3 Minecraft classes.
