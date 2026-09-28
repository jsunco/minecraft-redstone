# Local circuit experiments

The runner applies input cases, waits for actual server ticks, reads named outputs, and compares them with expectations. One request runs the whole experiment locally. MCP and the CLI use the same engine; changing the interface does not make Minecraft simulate faster. The circuit computes the answer in redstone, and local code only controls inputs and checks observations.

## First experiment

1. Load the Fabric lab world and keep simulation running. A paused single-player world cannot complete a tick-based test.
2. Build a lever connected to a redstone lamp in an inspected area. Every input must already be a loaded vanilla `minecraft:lever`. The runner preserves its face and facing, changes only `powered`, and requests normal block updates.
3. Copy [lamp-circuit.json](../examples/lamp-circuit.json) and [lamp-test.json](../examples/lamp-test.json). Replace both sets of coordinates with the actual blocks. The example coordinates are placeholders, not permission to edit that location.
4. Give the circuit definition to the MCP `circuit_register` tool. This names outputs; it does not build the circuit. The example expects the lamp's `lit` property as 0 or 1.
5. Validate the test, then run it. Choose enough settling ticks for the actual wiring; lamps take time to turn off. The example allows eight server ticks per case.

```sh
npm run circuit:test -- validate --spec examples/lamp-test.json
npm run circuit:test -- run --spec examples/lamp-test.json
npm run circuit:test -- status
npm run circuit:test -- cancel --job JOB_UUID
```

`run` stays in the foreground and prints one compact JSON result. Use another terminal for `status` or `cancel`, or press Ctrl-C. For scripts needing stdout to contain only JSON, invoke `node scripts/circuit-test-cli.mjs` directly (npm also prints its script banner). `--help` lists options. Exit codes are 0 for success, 2 for a failed or incomplete experiment, 1 for setup/usage errors, and 130 for interruption.

Paths default to the plugin's existing `.mcp.json`, with environment variables taking precedence. Explicit `--project DIR` and `--config-dir DIR` override those. The project is the one containing `.minecraft-assistant/circuits/circuits.json`. The config directory contains the game's `config.json` and `client.json`; authentication headers are loaded locally. Never paste tokens into a test spec or command.

## Through MCP

Use the `circuit_test` tool with these arguments:

```json
{"action":"validate","spec":{"circuit_id":"lamp","inputs":[{"name":"switch","position":{"x":0,"y":64,"z":0}}],"cases":[{"name":"on","inputs":{"switch":true},"expect":{"light":1}}],"settle_ticks":8}}
```

Change `action` to `start` to begin. Start returns a `job_id` immediately; each test case runs without an additional model turn. Then use:

```json
{"action":"status","job_id":"JOB_UUID"}
{"action":"cancel","job_id":"JOB_UUID"}
```

Omit `job_id` from status to list recent runs. Cancellation is a request, not proof of completed restoration; check the final status and `restore` field. Status/cancel are available while the job runs, outside the ordinary tool queue. A CLI process can inspect or cancel an MCP-started job in the same project, and vice versa.

## What a spec means

- `circuit_id`: a registered named circuit; `expect` can reference its signals or little-endian buses.
- `inputs`: 1–16 unique names and positions of existing levers. Every case must specify every input as `true` or `false`.
- `cases`: 1–256 uniquely named cases, each with at least one expected unsigned output within its registered width.
- `settle_ticks`: 1–200 ticks per case, default 4. Total requested settling is capped at 6,000 ticks. This is an observation delay, not an automatic proof that the circuit has stabilized.
- `timeout_ms`: wall-clock deadline of 1–300 seconds (`1000`–`300000` ms), default 60 seconds. Cleanup has a separate 10-second budget checked between bounded calls, so restoration can continue after the deadline.
- `stop_on_failure`: default true. False runs later cases after assertion failures; invalid reads and unsafe state still abort.
- `restore_inputs`: default true. False deliberately leaves final input values. Restoration changes levers back; it cannot reverse memory writes, piston movement, or other downstream circuit effects.
- `trace`: default false. True records output changes at native end-of-server-tick boundaries, drains them locally, and releases the native recorder slot. Coverage must reach the final test observation; an expired trace or missing coverage prevents an overall pass even when output assertions passed.

Inputs are applied **sequentially**, then read back, then allowed to settle. They are not a simultaneous bus transaction. For clocked circuits, keep the clock inactive while changing data and include an explicit clock input sequence. Initial verification should use combinational circuits.

Unknown or unloaded outputs never pass. No advancing server ticks for five seconds, a reversed clock, changed definitions, changed inputs, or a different world session stop the run with an explicit reason. Keep a single-player world unpaused during the run; a paused world cannot be made to pass by waiting longer on the local clock. Failed expectations remain failed even if a later case passes. Tick traces can miss pulses that begin and end within one tick; a passing final-state assertion does not prove absence of glitches.

## Result status

`status` is one of `running`, `passed`, `failed`, `cancelled`, `timed_out`, `aborted`, or `interrupted`. `passed` and `failed` are also numerical case counts in the summary. Use the status, completed/total counts, restoration result, and requested trace coverage together; successful cases in a partially completed, aborted run do not establish a passing experiment.

## Evidence and metrics

The summary includes `duration_ms`, input read/write counts, output observations, trace operations, and `response_json_bytes`. `metrics.latency_ms` reports count, total milliseconds, and maximum milliseconds for each operation category, including failed calls. These are measured at local runner boundaries, not tokens, API cost, network bytes, or model latency. Detailed cases, observations, and input journals stay in:

```text
<project>/.minecraft-assistant/tests/runs/<job-id>.json
<project>/.minecraft-assistant/tests/runs/<job-id>.jsonl
```

Optional tick traces also live under `.minecraft-assistant/circuits/`. Summaries are bounded to 8 KB and list at most five failures with omission counts. Specs are limited to 128 KiB on the CLI. Local history is capped at 128 jobs; archive completed evidence before creating more. These project artifacts are excluded from Git.

For an honest transport comparison, run identical cases in the same loaded world, compare results first, and report startup, game settling, call timings and bytes separately. The MCP worker already avoids per-case model turns. The CLI shares its underlying connection protocol; it is not a binary transport benchmark. No live token or quota reduction follows from a JSON-byte reduction alone.

## Conflicts and interruption

One advisory writer lock per project coordinates the CLI, test jobs, compact MCP build operations, circuit registration, trace mutations, telemetry reconfiguration, and observer movement. Existing world edits outside these tools cannot be locked; input readbacks detect conflicts and restoration refuses to overwrite unexpected changes. Keep the circuit area unchanged while running.

Ctrl-C/SIGTERM requests cancellation and waits for bounded cleanup. A killed process or power loss cannot safely restore inputs automatically. Its input journal and `.minecraft-assistant/.writer-lock/owner.json` remain available. Status marks a dead owner's run interrupted. Inspect the saved world/session and lever journal, verify the owner PID no longer runs, and only then remove the abandoned `.writer-lock` directory before explicit recovery. The tool never guesses that a lock is safe to steal.

This tests a circuit in the instrumented Fabric world. Repeat the finished computer's demonstration in unmodified Minecraft before claiming vanilla correctness.
