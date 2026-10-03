# building

Tools place vanilla blocks; Minecraft computes the results. Work in an inspected, isolated area with its clock stopped. Register a bounded region, create a plan, inspect it, apply it and verify the readback.

| tool | use |
| --- | --- |
| `build_region` | register a named region |
| `build_plan` | bind operations to the current blocks and server session |
| `build_preview` | inspect operations, materials and changes |
| `build_apply` | back up the region, place blocks and read back |
| `build_verify` | compare block IDs and requested properties |
| `build_undo` | restore the snapshot after conflict checks |
| `build_status` | inspect saved plans; follow `next_offset` for older entries |

A region has at most 4,096 cells. Plans allow 128 operations and 4,096 total block writes, including repeated writes. `set` takes `position` and `block`; `fill` takes `box` and `block`; `clone` takes `source_box` and `destination`. Boxes use inclusive integer `from`/`to` coordinates. Clone source and destination must be non-overlapping and inside the same region.

Example `build_plan` after registering `lab`:

```json
{
  "id":"support","region_id":"lab","label":"stone support",
  "operations":[{"op":"set","position":{"x":0,"y":64,"z":0},
    "block":{"id":"minecraft:stone"}}]
}
```

Replace example coordinates with the inspected location. Preview/apply/verify take `{"plan_id":"support"}`. Preview does not refresh a stale baseline; changed contents require a new plan.

The palette includes supports, dust, torches, switches, repeaters, comparators, lamps, waxed copper bulbs, pistons and observers. Unknown existing blocks stop planning. Containers, arbitrary NBT and command blocks are excluded. Exact schemas are in [build-service.mjs](../scripts/build-service.mjs).

## backup and recovery

Before placement, apply checks the original fingerprint, saves the whole registered region to an on-disk `mcredstone:undo/` structure, then checks for intervening edits. Readback scans include air. Each native batch is atomic; a multi-batch region scan is not.

A readback mismatch is `applied_unverified`, not circuit acceptance. A failed write may have executed partially. The service attempts rollback only if observed blocks are compatible with the attempted operations; conflicts or lost connections retain recovery evidence.

Undo requires the recorded post-apply fingerprint. An `undo_conflict` needs inspection; supplying the exact newly observed `expected_fingerprint` explicitly restores over those observed changes. There is no boolean force bypass, and verify does not reset the undo baseline.

Restart marks unfinished mutations `interrupted`; it never replays them. Use `build_status` to recover snapshot references. A changed server session refuses old plan writes. Keep the journal and handle old-world snapshots explicitly rather than deleting records to bypass a refusal.

The shared project writer lock coordinates these tools, not other players or Minecraft updates. Snapshots exclude entities; fingerprints do not cover inventories, scheduled ticks or neighbor effects outside the region. Keep world backups. Geometry readback and [circuit tests](TEST_RUNNER.md) establish different things.
