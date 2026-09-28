# Verification record — 2026-09-27

## Automated checks

- `npm test`: **157 JavaScript tests passed**, including actual MCP SDK stdio negotiation, local HTTP authentication, runner cancellation, failure/recovery paths, cross-process coordination, strict input validation and bounded output. Most game behavior is simulated here; live checks are listed separately below.
- Minecraft 26.3 server/client sources compile. The prior full native run passed **449 Java tests**, followed by **11/11 focused native/recorder checks**. Native runtime source and JAR are unchanged for this runner and showcase update. A previous full Gradle rerun stalled fetching dependencies; 449 is the earlier full-suite result.
- Native JAR SHA-256: `6242e9577c1f446fa7fb83f23c52a128107913fd173e25c171d6e04e58037557`.
- The compact MCP catalog exposes **18 tools**, including `circuit_test`. CLI and MCP use the same local job engine. Build/runner/observer mutations retain write annotations; default telemetry remains disabled.
- Four Java TOON fixture outputs round-trip through the decoder. Live construction found another upstream encoder shape that lost nested position indentation; construction scans now use validated native block batches. Four regression tests cover real TOON decoding, full coverage and session consistency.

## Live Minecraft checks

Tested in a new, isolated Creative Superflat world using Minecraft Java **26.3**, Fabric Loader **0.19.5**, bridge **1.1.0-redstone.1**, Java **25** on macOS. The user created and entered the world. Existing worlds were preserved. World/client endpoints use authenticated loopback connections.

| Check | Observed result |
| --- | --- |
| World and player reads | Live version, world session, position and player identity returned |
| Player inventory views | Atomic response with 36 main slots, 27 Ender slots and 8 equipment entries; main inventory empty |
| Construction | Preview, disk backup, apply and readback succeeded for a stone pad, two levers, six dust pieces and a lamp |
| CLI OR truth table | Five cases passed (00, 10, 01, 11, 00), including lamp turn-off; **2.309 seconds**, both inputs restored |
| Negative assertion | Deliberately expected 0 for a powered lamp; correctly reported actual 1 and exited with code 2; input restored |
| MCP background job | **64/64 repeated OR cases passed in 27.945 seconds**; complete tick trace, no gaps, both inputs restored |
| Cancellation | MCP cancelled a running 64-case job after two completed cases; both inputs restored |
| Paused world | Minecraft logged a pause during a prior run after 38 passing cases; native ticks stopped and the runner aborted after its five-second stall threshold, restoring inputs and draining the trace. A second paused attempt aborted before completing a case. |
| Image | GUI-preserving capture showed the actual OR fixture; no assistant command moved or rotated the user's body |
| Final cleanup | Both inputs off, lamp/wire off, all four local traces discarded, native recorder list empty |

The Minecraft circuit generated the outputs. The runner changed existing lever inputs and compared independent expectations to native wire/lamp observations. Test loops, detailed traces and low-level replies stayed local; only bounded job results need reach the assistant. These checks do not establish a completed GPU or learner mastery.

## Larger arithmetic showcase

A vanilla four-bit ripple-carry adder now occupies 60×73×9 blocks, with 5,943 non-air blocks. Thirty backed-up construction tiles read back 39,420 positions with no placement mismatches. The single-bit full adder passed all eight input combinations; the completed four-bit circuit passed all **256 operand pairs with carry-in zero**, split across eight jobs, in **1,521.124 seconds**. All eight jobs restored inputs and retained complete traces with zero gaps.

Each case waited 100 advancing server ticks. One recorded carry transition still showed 8 at offset 64 and settled to the expected 16 at offset 86. The configured tick rate was 20 TPS; the measured suite duration includes waiting and orchestration, and is not MCP transport latency. See the [arithmetic case study and all 256 observations](ADDER_CASE_STUDY.md).

The user explicitly authorized temporarily positioning their character for the native screenshot/video captures and restoring its position/view afterward. This is separate from the unverified independent spectator controller. [Media provenance](assets/README.md).

A deliberate one-wire carry fault made `1+1` produce `0`; the CLI failed with exit 2 and restored inputs. Snapshot undo verified the exact block restoration, and all six repair cases passed with complete traces. Final output was zero. This checks one-cell undo, not whole-structure recovery. [Fault evidence](data/carry-fault-validation.json).

## Performance evidence

The reproducible [live benchmark](LIVE_BENCHMARK.md) compares individual and batched reads, plus full and exact-delta encodings of the same samples. It measures call duration and serialized JSON bytes, **not model tokens, cost or quota**. It does not compare alternative transports or isolate MCP overhead.

The older synthetic fixture benchmark (`npm run benchmark`) produced 13,264 compact versus 603,325 raw JSON bytes at equal fixture polling coverage. Backoff separately reduced mock reads by observing less often. Synthetic and live results must remain separate.

## Remaining acceptance boundaries

- Whole-structure undo, populated containers/inventory entities, unloaded blocks, live world-restart/session-change recovery and dimension changes still need dedicated live checks; automated tests cover related paths.
- A separately connected rendered spectator client is not present. Independent movement/camera behavior has not been verified live.
- Input restoration does not reset downstream circuit memory, pistons or other effects. End-of-tick traces can miss within-tick pulses; sequential input writes are not simultaneous.
- The selected two-lane programmable computer has not been built, and final execution in unmodified Minecraft remains required.
- Actual model-token usage, billing, end-to-end assistant speed and superiority over other transports remain unmeasured.
- Other Minecraft versions, Linux/Windows runtime setup, upstream formatting/checkstyle tasks and GameTest execution are not established.

Generated profiles, credentials, saves, raw local recordings, private coordinates, build caches and compiled JARs remain excluded from Git. Source, tests, reproducible procedures, anonymous evidence and explicitly selected in-game media are published. The inherited generic-event listener retention limitation remains documented in [bridge/README.md](../bridge/README.md); compact state and native trace paths do not rely on those listeners.
