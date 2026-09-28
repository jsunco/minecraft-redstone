# Bounded construction tools

`BuildService` is a planner and construction adapter for the redstone laboratory.
It uses an injected `bridge.call('world', tool, arguments)`; tests never connect to
Minecraft. Set/fill/clone placement accelerates construction. The resulting
circuit still computes with ordinary Minecraft blocks and redstone.

## Tool registration API

Exported from `scripts/build-service.mjs`:

| Method | Zod schema | Minecraft effect |
| --- | --- | --- |
| `status({offset?, limit?})` | `buildStatusSchema` | None; paginated local journal only |
| `registerRegion(args)` | `buildRegionSchema` | None; registers a bounded lab area |
| `createPlan(args)` | `buildPlanSchema` | Reads the region and binds the plan to its current state/session |
| `preview({plan_id})` | `buildPlanRefSchema` | Reads current state; returns operations and compact summaries |
| `apply({plan_id})` | `buildPlanRefSchema` | Saves a structure snapshot, applies operations, reads back |
| `verify({plan_id})` | `buildPlanRefSchema` | Reads current block IDs/properties and reports mismatches |
| `undo({plan_id, expected_fingerprint?})` | `buildUndoSchema` | Restores the saved structure after conflict checks |

Every method returns an MCP text result. `apply` and `undo` return `isError: true`
when a started mutation fails; the text retains partial-completion and recovery
evidence. Validation and preflight failures throw. Calls serialize internally.
Registering the same region with identical settings is idempotent; a changed
definition requires a new ID. Failed journal writes roll back newly registered
regions and plans in memory so retries cannot falsely report saved work.

`build_status` returns the newest plans first, with `total_plans`, `offset`, and
`next_offset`. It defaults to 16 plans per page and accepts a limit of 1–32.
Follow `next_offset` to recover older snapshot references after context loss.

```js
const builds = new BuildService(bridge, {stateDir: '/absolute/project/.minecraft-assistant/build'});
await builds.registerRegion({
  id: 'adder_lab', dimension: 'minecraft:overworld',
  box: {from: {x: 0, y: 64, z: 0}, to: {x: 15, y: 71, z: 15}},
  description: 'Reserved redstone workspace',
});
await builds.createPlan({
  id: 'adder_floor', region_id: 'adder_lab', label: 'Stone support floor',
  operations: [{op: 'fill', box: {from: {x: 0, y: 64, z: 0}, to: {x: 15, y: 64, z: 15}},
    block: {id: 'minecraft:stone'}}],
});
await builds.preview({plan_id: 'adder_floor'});
await builds.apply({plan_id: 'adder_floor'});
```

Preview is an inspection facility, not a separate permission ritual. A valid
created plan may be applied directly within the user's authorized building task.
Preview never silently refreshes a stale baseline: changed lab contents require
a fresh plan.

## Boundaries and efficient output

- Up to 4,096 blocks per registered region, 128 operations per plan, and 4,096
  total operation-block writes including repeated writes. Split larger builds
  into named modules.
- `set` requires `position` and `block`; `fill` requires `box` and `block`; `clone`
  requires `source_box` and `destination`. All coordinates are absolute integer
  `{x,y,z}` objects. Boxes are inclusive and normalized.
- Clone uses ordinary `normal` copy, not move/masked/cross-dimension copy. Its
  source and destination must fit the same registered lab and must not overlap.
- A restricted palette permits basic supports, colored wool/concrete/glass,
  redstone, switches, repeaters, comparators, lamps, pistons, and observers.
  NBT injection, arbitrary commands, fluids, TNT, command blocks, portals,
  inventory/container writes, and player/entity changes are not exposed. Unknown
  existing blocks in the registered region cause planning to stop rather than
  risking their data during restoration.
- One bounded `block_scan_region` retrieves every coordinate, including air,
  using `limit = region volume`. Exact coverage is checked. Full readings remain
  internal; callers receive counts, fingerprints, up to 16 materials/preview
  operations, and up to 8 mismatch examples. Additional list truncation keeps
  text within 12,000 bytes and reports omitted counts. Raw scans are not model output.
- Runs of at least four set/fill operations use `block_fill_batch`, up to 32
  entries per call, preserving operation order. Clone operations remain separate.
  Plan descriptions report the resulting placement-call count. Batches retain
  the same region, volume, snapshot, failure, and readback guards.

## Snapshot, verification, and recovery contract

Before the first placement, `apply` verifies the plan's original fingerprint,
saves the **entire registered region** with `structure_save_from_world`, and
checks `structure_get_info` for expected dimensions and `onDisk: true`. A second
read checks for changes while the snapshot was saved. Structure names use the
`mcredstone:undo/` namespace and are never reused intentionally.

Readback compares all block IDs and explicitly requested block-state properties.
Clones and untouched cells carry their scanned properties. A mismatch produces
`applied_unverified`; it never claims a working circuit. Dynamic redstone updates
can legitimately produce mismatches. Truth tables and timing tests remain separate.

If a tool fails after placements begin, the service checks whether the current
blocks are compatible with the original state and attempted operations. When
they are, it attempts snapshot restoration and verifies the original fingerprint.
Unexpected changes suppress automatic rollback and produce a conflict report.
Disconnection or failed restoration retains `partial` status and the snapshot
name. An operation that threw may have executed partially; completed-operation
counts include only acknowledged calls.

Undo requires the current position-sensitive block/state fingerprint to match
the recorded post-apply fingerprint. Changed materials, positions, orientations,
or redstone properties therefore trigger `undo_conflict`. Inspect first. Passing
the **exact newly observed** `expected_fingerprint` explicitly requests restoring
over those observed changes. `verify` does not move the undo baseline. No boolean
force bypass exists.

The journal is atomically replaced under `stateDir` (default
`~/.codex/minecraft-redstone/build-state`). Project integrations should choose an
ignored project-local runtime folder. `stateDir: null` supports isolated tests.
Restart loads the journal without any game calls and marks unfinished mutations
`interrupted`; it never automatically replays them. Saved structures remain in
the Minecraft world's own structure storage; the journal stores identifiers and
scanned block states, not screenshots or player metadata.
Journal loading revalidates region and operation bounds, the permitted palette,
position coverage, baseline fingerprints, and calculated expected states.
Inconsistent or corrupted journals are refused before any game call; preserve
the file for inspection or recover a known-good backup rather than deleting
snapshot references blindly.

All writes require a `session_id` from `server_get_status`, supplied by the local
bridge extension. A plan created without that identity can be inspected but
cannot be applied. A changed session refuses apply/undo; create a fresh plan and
handle old-world snapshot recovery explicitly. An upstream bridge lacking this
extension remains usable for read-only plan inspection.

## Limits of restoration

These operations are serialized within this service, **not transactions locking
Minecraft**. Another player, a running clock, scheduled ticks, pistons, or neighbor
updates may change the world between reads. Work on stopped, isolated modules.
The scan API exposes IDs and properties, not block-entity NBT, inventories,
entities, or scheduled ticks. Those are not covered by fingerprint conflict
detection. Snapshots include block data but exclude entities. Restoring a region
does not reverse neighbor effects or state changes outside it, and does not prove
behavioral or timing equivalence. Keep world backups for important builds.

## Upstream schema references

Argument names and acknowledgements come from the pinned vendored upstream:

- `bridge/vendor/src/main/java/com/chapmanjw/minecraft/fabric/mcp/tools/block/BlockTools.java`
  (`block_get_state`, `block_scan_region`, `block_set_state`, `block_fill_region`,
  `block_fill_batch`, `block_clone_region`).
- `bridge/vendor/src/main/java/com/chapmanjw/minecraft/fabric/mcp/tools/structure/StructureTools.java`
  (`structure_save_from_world`, `structure_get_info`, `structure_load_to_world`).
- `bridge/vendor/src/main/java/com/chapmanjw/minecraft/fabric/mcp/adapter/impl/BlockOps.java`
  confirms unfiltered scans include air and return IDs/properties.

`node --test scripts/build-service.test.mjs` uses a fake bridge to exercise stale
plans, incomplete scans, snapshots, failures midway through operations, rollback,
conflicts, missing identity, concurrent calls, and journal restart behavior.
