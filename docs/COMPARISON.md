# What this adds, and what it does not

This project adapts an existing Fabric MCP server for repeatable redstone experiments. The useful distinction is where the work happens: Minecraft computes the circuit, a local worker runs the experiment, and the assistant receives selected state or a bounded result. MCP remains the control interface.

Reviewed **2026-09-27** (Pacific time). Capabilities below are supported by the linked source snapshots; other projects were **not installed or timed**. A missing feature in their published catalog is not proof that nobody could implement it. The benchmark is a comparison of read paths within our running fork, not a clean-install race against an upstream release or a competing product.

## The upstream foundation

We use John Chapman’s [Minecraft Java Fabric MCP server](https://github.com/chapmanjw/minecraft-java-fabric-mcp-server/tree/e2d571ca087ee26fadc431319d2632ce677d88da), under its MIT license. Its pinned source already provides direct world access, block edits and scans, batch fills, structure save/load, inventories, events, TOON output, access filtering and a real-client screenshot endpoint. Those are inherited capabilities, not inventions of this project. [Upstream reference](https://github.com/chapmanjw/minecraft-java-fabric-mcp-server/blob/e2d571ca087ee26fadc431319d2632ce677d88da/README.md).

| Need | Foundation already available | Addition here |
| --- | --- | --- |
| Read a circuit | Individual block state and region scan tools | Up to 512 arbitrary positions in one server task, explicit unloaded states, server tick and world-session identity |
| Keep context small | Structured TOON replies; configurable tool categories | Selected fields, exact deltas, bounded summaries, local caches and controlled observation cadence |
| Observe transitions | Generic event subscriptions | End-of-server-tick block-state recorder, resumable cursors, explicit gaps and recovery baselines |
| Test a truth table | Low-level actions can be composed by any client | One local job handles lever cases, actual tick settling, assertions, trace coverage, cancellation and conflict-checked input restoration |
| Edit safely | Block fill/clone and structure persistence | Previewed plans, saved baseline and structure backup, session checks, readback and conflict-aware undo workflow |
| Inspect a player | Player/container tools and client sensing | One atomic view of main inventory, selected slot, Ender chest and equipment |
| Obtain a separate view | Screenshot of the client owning its endpoint | Distinct spectator-identity controller; still needs a second rendered client and remains unverified live |

The new [native tools](../bridge/README.md) extend the server; the [local service](ARCHITECTURE.md) adds experiment semantics. Ordinary pictures are still available on demand. A multi-batch region scan is not one atomic snapshot, traces cannot see every within-tick pulse, and restoring levers does not rewind downstream memory or pistons. The fork’s exact 26.3 target also disables three legacy fuel/compost registry tools whose old semantics no longer apply.

## Measurements we can defend

The [live read benchmark](LIVE_BENCHMARK.md) used the same eight loaded OR-fixture blocks, one persistent connection, 20 alternating measured rounds and two warmup rounds per path. It ran in Minecraft Java 26.3 with the Fabric helper.

| Same live workload | Individual reads | Native batch |
| --- | ---: | ---: |
| Requests across 20 rounds | 160 | 20 |
| Median summed call duration per round, pacing excluded | 23.855 ms | 3.161 ms |
| 95th percentile summed call duration | 43.371 ms | 8.272 ms |
| Raw serialized response-object bytes | 37,260 | 40,780 |

That is a **7.55× ratio of median workload call times** and **87.5% fewer requests**. A single batched request was not faster than a single individual request; requesting eight blocks required fewer calls. Raw batch replies were larger in total because they carry metadata. The generic reader also returns extra detail, so its raw byte count is not an equal-information compression baseline.

Encoding the **same 20 batch samples** as selected full snapshots used **17,818 bytes**; one full snapshot followed by exact unchanged records used **1,839 bytes**, **89.679% fewer**. The fixture was unchanged. This does not predict compression for a busy circuit and does not measure model tokens, cost, screenshot usage or quota. Intentional request pacing is excluded from the call-duration numbers above and separately reported in the benchmark.

The live tool catalog was also measured on 2026-09-28 at 01:04 UTC: this configured installation exposed 126 world tools plus six client tools, totaling **97,454 serialized JSON bytes** of definitions. The compact interface exposed 18 tools totaling **19,252 bytes**, about **80.2% less schema JSON**. This is intentional curation of the assistant-facing interface, not equivalent catalogs or a measured token saving. It includes our native extensions and enabled categories, so 132 is **not** upstream’s default tool count. Native discovery remains available through the local adapter.

A [64-case live OR experiment](VERIFICATION.md) passed in **27.945 seconds**, with complete trace coverage and restored inputs. Incorrect expectations, cancellation and a paused world also exercised failure paths. This establishes working local orchestration, not a speedup over an equally capable hand-written script: another MCP client could keep its loop local too. The CLI and MCP share the same runner and downstream protocol.

## A changing circuit: a second encoding check

The first 32-case job of the four-bit adder sweep passed on September 28 at **01:25 UTC** (September 27 Pacific time). Its five output lamps produced **109 recorded change entries** across 3,777 server ticks, with no reported gaps or dropped/missed samples. We reconstructed a full selected state at each actual change entry and included the recorder’s initial baseline: **110 observations**, not one invented observation per unchanged tick.

Using the same `DeltaCache` as the live read benchmark, those 110 observations required **40,433 bytes as repeated full selected states** or **12,505 bytes as one baseline plus 109 exact deltas**, a **69.072% reduction**. All 110 delta-decoded states matched their full counterparts. No resynchronization was needed in this trace; one initial full state is included in both totals. [Anonymous observations, schemas and aggregate result](assets/active-adder-encoding.json).

Each selected block has only `id` and `properties.lit`, in the fixed order of the five output lamps. Both encodings include the same relative tick. Byte counts are the sum of compact UTF-8 `JSON.stringify` results, excluding newline framing. This is **offline encoding of a real changing trace**, not measured traffic or model usage. It covers the output lamps and these change-driven observations; it does not predict the result for all internal wires, another cadence or another schema. It also does not demonstrate a speedup in the game.

To reproduce the encoding totals from the published data, run this from the repository root:

```js
import {readFileSync} from 'node:fs';
import {DeltaCache} from './scripts/telemetry-core.mjs';
const {samples} = JSON.parse(readFileSync('docs/assets/active-adder-encoding.json'));
const cache = new DeltaCache();
let full = 0, delta = 0;
const bytes = value => Buffer.byteLength(JSON.stringify(value));
for (const {tick, value} of samples) {
  full += bytes({tick, kind: 'snapshot', watchId: 'blocks', value});
  delta += bytes({tick, ...cache.sample('blocks', value, {maxBytes: 1_000_000})});
}
console.log({full, delta}); // { full: 40433, delta: 12505 }
```

The [timing case study](TIMING_CASE_STUDY.md) separately examines what sparse polling can miss. Compressing observations and capturing transitions are different operations.

## Related approaches

| Project | Documented strengths | Difference for this project |
| --- | --- | --- |
| [Chapman’s companion Claude plugin](https://github.com/chapmanjw/minecraft-java-fabric-claude-plugin/tree/262850795f317a8e4340987bbbe4a8d0ecb68afe) | Guided setup, building/terrain skills, reusable structure templates, a redstone specialist and in-world verification | A broader construction workflow. Our focus is a Codex-facing experimental interface, compact observations and bounded recoverable test jobs. The companion already does functional redstone verification. |
| [Yuniko’s Mineflayer MCP](https://github.com/yuniko-software/minecraft-mcp-server/tree/240c8cec337ce152cc9e058ebdef511055808406) | Joins a LAN/server as a separate bot; movement, flying, inventory, block interaction, smelting and chat | A natural fit for an embodied helper without requiring this Fabric instrumentation. Its README names 1.21.11 support; compatibility with our 26.3 lab is not established. A separate bot’s state is not automatically an authoritative same-tick server snapshot. |
| [Dylan’s Minecraft Redstone MCP](https://github.com/dylan121322/minecraft-redstone-mcp/tree/70f93081d93a696f03398f3cf7510eee12106d8a) | Verilog/Yosys synthesis, placement and routing, MCHPRS simulation, schematic export and bot construction; reports a 23-gate ALU with 40/40 in-game cases | This is the more relevant design/synthesis alternative. We have not implemented that synthesis pipeline. Our emphasis is observing and testing an existing live build; its reported results are not independently reproduced here, and behavioral simulation results must not be presented as physical Minecraft results. |

These are complementary tradeoffs. A bot is useful for autonomous play; a synthesis pipeline is useful for converting logic into layouts; the Fabric path provides server-side instrumentation for controlled experiments. We have not measured comparative reliability, total setup effort or end-to-end agent speed.

## Three reproducible comparison cases

1. **Sparse, stable circuit reads.** Choose 8, 32 and 64 loaded signal positions. Compare the inherited `block_get_state` loop with `block_get_states_batch`, alternating order after warmup. Require matching selected values and advancing ticks. Report request count, p50/p95, actual call time, full elapsed time, metadata and equal-field JSON bytes. If all signals fit a small region, also evaluate the upstream region scan; individual calls are not its only option.
2. **A changing combinational circuit.** Run the identical truth table and settling rule on the same physical build. Compare full and delta encodings from the *same captured observations*, including the initial full state and resynchronizations. Count complete cases, failures and local low-level calls. Keep assistant-facing summaries separate from local trace volume. A hand-written local baseline must also run without artificial per-case model turns.
3. **A short pulse plus interrupted run.** Record a repeatable multi-tick pulse while polling more slowly, then compare native tick coverage with the sparse polls. Start another job, cancel it, and verify each input’s original value. Separately exercise timeout and a conflicting edit. Report observed transitions and recovery outcomes; never infer the absence of a pulse from unchanged sparse polls, or claim that a tick recorder captures sub-tick ordering.

The eight-block read comparison, active-adder encoding and initial runner recovery checks are recorded above. The [arithmetic case study](ADDER_CASE_STUDY.md) tracks circuit correctness; the [OR trace analysis](TIMING_CASE_STUDY.md) tracks sparse-sampling limits. These dated experiments remain separate from the original benchmark. Cross-project speed claims require matching Minecraft versions, world, hardware, loaded chunks, output semantics and safety behavior first.

## Source snapshots

GitHub default-branch heads were checked on the review date. The upstream head still matched our vendored base. Links above pin the content used for this comparison.

| Source | Reviewed commit |
| --- | --- |
| `chapmanjw/minecraft-java-fabric-mcp-server` | `e2d571ca087ee26fadc431319d2632ce677d88da` |
| `chapmanjw/minecraft-java-fabric-claude-plugin` | `262850795f317a8e4340987bbbe4a8d0ecb68afe` |
| `yuniko-software/minecraft-mcp-server` | `240c8cec337ce152cc9e058ebdef511055808406` |
| `dylan121322/minecraft-redstone-mcp` | `70f93081d93a696f03398f3cf7510eee12106d8a` |
