# verified results

Updated 2026-10-02. Recorded game checks used Minecraft Java 26.3, Fabric Loader 0.19.5 and Java 25 on macOS. This update made no new game runs.

| check | result |
| --- | --- |
| automated | 173 JavaScript tests passed; native build succeeded with 476 passing cached JUnit results |
| inspection | world/player reads, 36 main inventory slots, 27 Ender slots and eight equipment entries |
| OR circuit | five CLI cases and 64 MCP cases passed; wrong expectations failed; cancellation restored inputs; paused ticks aborted |
| construction | 30 backed-up adder tiles read back 39,420 positions; one-wire fault and undo passed |
| arithmetic | all 256 four-bit operand pairs passed with carry-in zero; 1,521.124 seconds, complete traces and restored inputs |
| administration | console/settings, new world, save/reopen, 100-TPS target, freeze/five-step/unfreeze; active-recorder quit refused; player pose preserved |

[Adder results and recording](ADDER_CASE_STUDY.md), [tick trace](TIMING_CASE_STUDY.md), [read benchmark](LIVE_BENCHMARK.md) and [media provenance](assets/README.md) retain the evidence.

The GPU design and build status live in [tiny-gpu-minecraft](https://github.com/jsunco/tiny-gpu-minecraft). This repository contains the general tooling and its circuit examples.

One 15-phase storage test took 190.748 seconds at 20 TPS and 72.310 seconds at 100 TPS, including host overhead. This pair does not establish sustained 100 TPS or whole-build speedup. Reload returned the target to 20 TPS before it was restored to 100.

## limits

Independent spectator rendering, whole-structure undo, populated containers/entities, unloaded blocks, interrupted-job recovery across restart, other operating systems and other Minecraft targets need further live checks. Clean save/reopen was tested. The inherited generic-event listener limitation is documented in [bridge notes](../bridge/README.md).

Restoring inputs does not rewind circuit memory. Tick-end samples can miss shorter pulses; loaded blocks may not be ticking. JSON-byte savings are not token, cost or quota measurements, and no comparative performance lead is established.
