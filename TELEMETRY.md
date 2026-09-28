# Compact observation

Structured game APIs replace repeated full-state dumps and routine screenshots. F3 need not be visible; no OCR is used. Raw readings stay in the local service, which selects fields and compares cached snapshots. It never continuously prompts the model. Polling occurs only on tool requests; explicitly started finite native traces sample inside Minecraft.

## Configuration

Modes: `disabled` (default, no telemetry reads), `data` (compact state), and `hybrid` (also explicit `telemetry_view` images). Other explicitly invoked circuit/build/observer tools have their own behavior. Disabling telemetry does not disable them.

Inspect `telemetry_source_schema` before configuring a watch. Example:

```json
{
  "mode":"hybrid",
  "min_poll_ms":5000,
  "max_text_bytes":8000,
  "max_concurrency":2,
  "no_change_backoff":true,
  "max_backoff_ms":60000,
  "watches":[
    {"id":"player","source":"client","tool":"client_status","arguments":{},"fields":["in_game","player_uuid","dimension","pos","yaw","pitch","held_item","held_count"],"interval_ms":5000},
    {"id":"target","source":"client","tool":"sense_crosshair","arguments":{},"on_demand":true}
  ]
}
```

Configure at most 8 watches. Configuration replaces watches and resets baselines. Identical tools and arguments share one upstream read, even with different field projections. Unique reads use bounded concurrency (default 2, maximum 4). Polls serialize baseline commits.

`telemetry_poll` reads due automatic watches. Explicit `watch_ids` bypass each watch's cadence/backoff but retain the global minimum. On-demand watches read only when selected or included in a full resync. Deferred replies report no fresh observation and the age of the last reading.

`full: true` requests a fresh baseline for selected watches, or all watches if none are selected. Use it after context loss or missed responses. Each watch also refreshes fully at its next actual read after 60 seconds. There are no hidden background reads. Oversized resyncs remain pending. A failed watch invalidates only its own baseline.

## Response contract

| Kind | Meaning |
|---|---|
| snapshot | Complete selected value |
| delta | RFC 6901 JSON Pointer removals followed by assignments against the previously delivered sample |
| unchanged | Equal at sampling times; intermediate transitions still possible |
| deferred | No fresh read, with freshness/cadence metadata |
| unavailable / oversize | Unknown, not a cached success |

Explicit unique slot IDs normalize to maps; implicit-index inventories retain indices. Missing/null/deleted values remain distinct. No numeric rounding. Default projection omits bulky NBT/components; explicit fields can request available values. TOON and JSON readings are validated.

The default total poll text budget is 8,000 UTF-8 bytes, configurable from 2,048 to 16,000. The default minimum interval is 5 seconds, increased with workload to leave space under upstream rate limits. Raw decoded readings are capped at 2 MB after SDK receipt, not at the network-stream layer. Region summaries cover at most 4,096 blocks; native batches cover at most 512 positions. Material histograms do not substitute for `power`, `lit`, or `powered` state.

Schema catalogs share discovery, expire after their time limit, and invalidate on refresh, tool-list changes, or disconnect. They report their age. `connection_check` defaults to fresh discovery; cached checks report `connection_checked: false`. Discovery is not proof that a world is loaded. The installed authenticated endpoints require the local configuration directory described in [setup](docs/MINECRAFT_SETUP.md); tokens are read locally and are never returned in observations.

## Pictures and timing

`telemetry_view` requires hybrid mode, defaults to `downscale: 4` (range 2–8), preserves the GUI with `close_screen: false`, and limits successful images to one per 30 seconds and 512 KB decoded. It takes no automatic pictures and performs no cropping. It sees the user's client. [Observer control](docs/OBSERVER.md) explicitly targets a separate spectator client.

Separate watch calls are not an atomic world snapshot. [`circuit_observe`](docs/CIRCUIT_TOOLS.md) reads a native batch in one server task. `circuit_trace` records finite end-of-server-tick samples with cursors, gap recovery, and local artifacts. No polling strategy reconstructs missed pulses.

## Reproducible synthetic measurement

Run `npm run benchmark`. Output is also saved in `scripts/telemetry-benchmark.json`.

| Mode, 25 polls and four fixture watches | Delivered JSON bytes | Mock upstream calls |
|---|---:|---:|
| Repeated raw reads | 603,325 | 100 |
| Compact every poll | 13,264 | 75 |
| Compact with backoff | 16,682 | 24 |

Compact reads on every poll preserve fixture coverage and reduce bytes by 97.80%. Backoff reduces reads by 76% against raw polling but observes less often. Freshness metadata can cost more text than unchanged samples, explaining the larger output compared with compact reads on every poll. These numbers do not establish live-game token billing, cost, quota, or latency.

`telemetry_status` counts poll payload bytes and screenshots. It does not count the whole conversation, tool schemas, other services, tokens, or account quota.
