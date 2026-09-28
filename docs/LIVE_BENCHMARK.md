# Measuring the live bridge

`scripts/live-benchmark.mjs` measures read calls against a running Minecraft
world. It does not place blocks, toggle inputs, move a player, capture a screen,
or upload results. It uses the existing local MCP connection; it is not a
comparison of MCP against a different transport.

## Run it

Keep the world loaded and unpaused, and finish other automated experiments
first. Choose a small set of loaded circuit blocks. Keep their coordinates in
an ignored local workload file, for example
`.minecraft-assistant/benchmark-workload.json`:

```json
{
  "dimension": "minecraft:overworld",
  "positions": [{"x": 0, "y": 64, "z": 0}],
  "rounds": 20,
  "warmup_rounds": 2
}
```

Replace that example coordinate with a block in your test area. The accepted
bounds are 1–64 distinct positions, 2–50 measured rounds per path, and 1–5 warmup
rounds. Multiple positions make the batching comparison useful.

```sh
node scripts/live-benchmark.mjs \
  --workload .minecraft-assistant/benchmark-workload.json \
  --output .minecraft-assistant/live-benchmark.json
```

Use the same `MINECRAFT_MCP_CONFIG_DIR` as the plugin. The script reads local
credentials without printing them. An output path must be new: it is created
with mode `0600` and never overwrites an existing report. The printed report
contains aggregate numbers, without coordinates, block IDs, player names,
session identifiers, or raw readings. The workload file itself remains private.

## What is measured

After warming both paths, each round reads the same requested positions using:

1. Sequential `block_get_state` calls, one per block.
2. One `block_get_states_batch` call covering every requested block.

The order alternates each round to reduce simple ordering bias. Both paths reuse
one connection. Requests start at least 125 ms apart. The staged bridge uses a
600-token bucket refilling at 10 requests/second; this benchmark's eight
requests/second stays below that sustained rate. Other callers share that budget,
so run this measurement without a concurrent test job.

The native batch supplies loaded-state, position, session, and tick metadata.
The benchmark refuses unavailable blocks, malformed replies, session changes,
backward ticks, or a measurement window without advancing ticks. Warmup calls
and the final session-check call are excluded from latency distributions and
payload totals; their counts are reported separately.

| Report field | Meaning |
| --- | --- |
| `latency` | For each round, the sum of actual upstream call wall times needed to read all blocks. Deliberate rate-limit waits are excluded. |
| `per_request_latency` | Individual call duration distributions; these have different sample counts for individual and batched paths. |
| `workload_wall_latency_including_rate_limit_waits` | End-to-end duration of each path in a round, including deliberate pacing and local decoding. |
| `response_object_json_bytes` | UTF-8 bytes after JSON-serializing returned MCP result objects. HTTP headers/framing are excluded. |
| `selected_state_encoding` | Full snapshots versus exact deltas of the **same measured batch samples**, including matching relative tick markers. |
| `observations` | Paired state agreement, tick advancement, and total elapsed time. |

Percentiles use the nearest-rank definition. Every distribution includes its
sample count, minimum, median, 95th percentile, maximum, and mean. The reported
median speedup divides the per-workload medians in `latency`; it is not a ratio
of per-request medians, nor does it include intentional rate-limit waits.

## Reading the result honestly

Individual calls span different server tasks. A native batch reads its blocks
in one server task. The two paths still run at different times, so a changing
circuit can legitimately produce different paired states. An agreement count
does not establish equal timing or prove the absence of short pulses.

The generic upstream reader exposes a lever's Java enum spelling (`FLOOR`,
`WALL`, `CEILING`); the native batch uses Minecraft's serialized state spelling
(`floor`, `wall`, `ceiling`). Pair comparison normalizes only those known values
for `minecraft:lever.face`. All other values compare exactly, and raw payload
byte totals are never normalized. The report states this conversion explicitly.

Raw individual replies contain light, hardness, and possibly block-entity NBT
that batch replies omit. Their raw byte totals therefore compare different
amounts of detail. The selected-state full-versus-delta comparison avoids that
problem: both encode exactly the same IDs and properties from each batch.
An unchanged fixture can compress particularly well; that result should not
be generalized to a changing circuit.

These are live tool-call durations and serialized byte counts. They do not
measure model tokens, billing, quota, screenshots, model turnaround, or total
assistant context. Server scheduling, tool execution, transport, and response
handling all contribute to latency. This test cannot isolate MCP overhead or
establish that a CLI or binary socket would be faster.

## Recorded live results

One local run completed on **2026-09-28 at 00:57 UTC**, against the Minecraft
Java 26.3 Fabric lab ([anonymous aggregate report](live-benchmark-2026-09-27.json);
September 27 in Pacific time). The workload was eight loaded blocks from a stationary
redstone OR fixture, 20 measured rounds per path, and two warmup rounds. All
20 paired selected states agreed after the lever-enum conversion above. The
server advanced 474 ticks during the measured window and final probe.

| Measurement | Eight individual reads | One eight-block batch |
| --- | ---: | ---: |
| Median summed call time per workload, pacing excluded | 23.855 ms | 3.161 ms |
| 95th percentile summed call time per workload | 43.371 ms | 8.272 ms |
| Median time per request | 2.874 ms | 3.161 ms |
| Median workload wall time, intentional pacing included | 1,002.378 ms | 125.464 ms |
| Measured requests | 160 | 20 |
| Serialized response-object bytes | 37,260 | 40,780 |

The median summed call time fell from **23.855 ms to 3.161 ms**, a **7.55× ratio**.
Its individual request was not faster, and its raw payload total was larger:
batch metadata has a cost. Fewer calls provided the improvement.

Encoding those same 20 batch observations as selected full snapshots took
**17,818 bytes**; one full snapshot followed by 19 unchanged records took
**1,839 bytes**, an **89.679% reduction**. This is an unchanged fixture and an
exact comparison of local encodings, not measured model tokens or billing.
The complete run, including warmup and pacing, took 24.840 seconds.

An earlier diagnostic run reported zero paired matches because of `FLOOR`
versus `floor`; investigation found that serialization difference on both
levers, with all other selected values matching. The results above come from
the subsequent complete run after the explicit comparison fix. This does not
change the independent same-batch full-versus-delta comparison.

These observations support batching reads and keeping repetitive processing
local. They do not compare transports or establish MCP as the fastest option.
The synthetic fixture benchmark in [TELEMETRY.md](../TELEMETRY.md) remains a
separate measurement.

## Construction scan regression

Live integration exposed an upstream `block_scan_region` TOON serialization
problem: when an array item began with a nested `position`, its coordinate
indentation was lost. Construction inspection now uses native batches, whose
scalar-first rows preserve that structure. It validates every loaded position
and plan session before accepting a baseline. Large regions use at most eight
512-block batches; each batch is atomic, the whole multi-batch scan is not.
The [construction contract](BUILD_TOOLS.md) covers backups and conflict checks.
The generic upstream encoder has not been changed by this workaround.
