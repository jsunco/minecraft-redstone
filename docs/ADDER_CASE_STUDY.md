# a vanilla arithmetic case study

The showcase is a real four-bit ripple-carry adder in Minecraft Java 26.3. Two four-bit operands and a carry-in feed five output lamps. A Fabric bridge places and observes blocks; vanilla torch, dust and repeater behavior computes every result. This is a tooling demonstration, not the finished programmable GPU or an unmodified-client acceptance test.

![The four-bit adder running in Minecraft](assets/adder-overview.png)

[Short in-game recording](assets/adder-run.mp4).

The spread-out layout makes signals easy to inspect. It occupies 60×73×9 blocks and contains 5,943 non-air blocks: 4,903 supports, 886 dust, 68 repeaters, 72 torches, 9 levers and 5 lamps. Thirty backed-up construction tiles read back 39,420 positions with no remaining placement mismatches. [Generate the layout and tests](../examples/ripple-adder.md).

## first find the mistakes

The first XOR prototype passed three truth-table rows and failed `1 xor 1`: expected 0, observed 1. A selected-state read showed the NAND torches were correct but both isolation repeaters remained unpowered. The generator had used repeater `facing` as signal-travel direction; that property names the input side. Reversing those orientations made all four rows pass.

The one-bit full adder then passed all eight input combinations, including carry-in, in 27.479 seconds with a complete tick trace and restored inputs.

Tiling four slices found a different class of failure. Construction readback caught a wire whose support had been overwritten by a descending path. After correcting support, `1 + 1` still produced 0. Internal wire readings showed power falling 10, 9, …, 1, 0 before the next repeater. Code review also found overlapping inter-stage carry paths. The final version separates the carry paths by column and elevation and refreshes signals before they die. These were layout errors; adding more waiting time would not repair them.

The corrected four-bit circuit passed a seven-case smoke run: 0+0, 1+1, 3+1, 7+1, 15+1, 15+15 and reset to zero. It took 44.871 seconds, restored its inputs and retained a complete gap-free trace. These transitions exercise arithmetic and overflow, but this smoke sequence alone is not exhaustive.

## exhaustive protocol

The full suite enumerates all 256 operand pairs, with carry-in held low, and compares the observed five-bit lamp bus with independently computed integer addition. It is split into eight 32-case jobs, each with 100 observed server ticks of settling per case, a 300-second wall deadline, native end-of-tick recording and input restoration. The configured tick rate remained 20 TPS. Sequential input writes are included in elapsed run time; they are not a simultaneous bus update.

Those settling windows alone total 25,600 game ticks: nominally 21 minutes 20 seconds at 20 TPS. Guarded input changes, observation and cleanup add time. The run duration measures this validation workload, not isolated MCP transport latency.

The first exhaustive chunk demonstrates why that settling budget matters: changing from `1 + 14` to `1 + 15` produced its last recorded lamp transition **86 server ticks** after the runner's post-input start. Replaying that trace at offset 64 gives 8, while the expected answer is 16. The carry lamp turns on at offset 82, then the lamp representing 8 turns off at 86. This is an offline reconstruction of the recorded end-of-tick states, not a separately run 64-tick experiment or a universal Minecraft-adder timing limit.

**All 256 cases passed**, with zero failures, in **25 minutes 21.124 seconds** of summed job time. Every job restored its input levers and retained a complete trace with zero reported gaps. A final live check found all nine inputs off, output 0 and no retained native recorders. The largest recorded post-input lamp-change offset across the suite was 86 ticks.

The [anonymous evidence file](data/adder-validation.json) contains all 256 expected/observed results, per-case settling and duration, per-job counters, prototype results and the timing replay. Across the eight jobs the worker made 1,348 input reads, 520 input writes, 5,119 circuit observations and 32 trace operations. It handled 6,229,232 JSON response bytes locally. Those byte counters describe adapter payloads, not model tokens, network traffic or billing.

This protocol checks the final output for each operand pair in one sequence. It does not cover all 65,536 transitions between operand states, clocked storage, every carry-in-one combination, or pulses occurring entirely within a tick. The eventual computer still needs a separate demonstration in unmodified Minecraft.

## break a real carry wire, then recover

After the full sweep, a one-cell construction plan backed up and removed dust from the first inter-slice carry connection. The real `1 + 1` output became **0**, instead of the expected **2**. The CLI correctly reported one failed assertion and exited with code 2, then restored the inputs.

A zero-input case settled the circuit before backup and again before undo, avoiding a fingerprint check against a still-changing carry signal. Snapshot undo returned `undone`, with exact readback restoration. Six post-repair cases passed: 0+0, 1+1, 1+15, 15+1, 15+15 and reset to zero. Input restoration and complete gap-free traces succeeded. The final observed output was zero. [Anonymous failure and recovery evidence](data/carry-fault-validation.json).

This is a physical fault, not just an intentionally wrong expected answer. It verifies one-cell backup/undo and arithmetic recovery; whole-structure undo and arbitrary sequential-circuit state recovery remain separate acceptance checks.
