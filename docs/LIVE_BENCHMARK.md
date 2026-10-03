# read benchmark

The September 27, 2026 eight-block experiment compared individual reads with one native batch across 20 rounds. Median summed call time was **23.855 ms vs 3.161 ms**, excluding pacing; requests fell from 160 to 20. Raw batch replies were larger. This compares workloads, not single-call latency or alternative transports.

Equal selected snapshots from the unchanged fixture used **17,818 JSON bytes** in full vs **1,839** with deltas. Offline encoding of 110 changing adder observations used **40,433 vs 12,505 bytes**. Neither measures tokens, billing or overall assistant speed.

[Read results](live-benchmark-2026-09-27.json) · [changing-circuit data](assets/active-adder-encoding.json) · [implementation](../scripts/live-benchmark.mjs)

To rerun, choose 1–64 loaded positions in an unpaused world and save a private workload file with `dimension`, `positions`, `rounds` (2–50) and `warmup_rounds` (1–5). Use the plugin's `MINECRAFT_MCP_CONFIG_DIR`, finish other test jobs, and choose a new output path:

```sh
node scripts/live-benchmark.mjs \
  --workload .minecraft-assistant/benchmark-workload.json \
  --output .minecraft-assistant/live-benchmark.json
```

The script only reads blocks; it rejects unavailable data, session changes and stalled ticks. Raw coordinates stay in local files. `npm run benchmark` is a separate synthetic fixture. [Current verification](VERIFICATION.md).
