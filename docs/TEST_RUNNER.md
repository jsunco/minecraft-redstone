# testing circuits

`circuit_test` and the CLI share one local engine. It changes existing levers, waits for advancing server ticks and compares named outputs. Redstone produces the answers. Start with the [lamp circuit](../examples/lamp-circuit.json) and [test](../examples/lamp-test.json), using your own inspected coordinates.

```sh
npm run circuit:test -- validate --spec examples/lamp-test.json
npm run circuit:test -- run --spec examples/lamp-test.json
npm run circuit:test -- status
npm run circuit:test -- cancel --job JOB_UUID
```

Register outputs through `circuit_register` first. For MCP, call `circuit_test` with `action: "validate"` or `"start"` and the spec; then `status`/`cancel` with the returned `job_id`. Status and cancellation work while the job runs. CLI and MCP can inspect each other's jobs in the same project.

## spec

| field | meaning |
| --- | --- |
| `circuit_id` | registered circuit whose signals/buses appear in `expect` |
| `inputs` | 1–16 uniquely named existing levers |
| `cases` | 1–256 unique cases; every input is boolean and every case has an expected output |
| `settle_ticks` | 1–200 per case, default 4; at most 6,000 total |
| `timeout_ms` | 1,000–300,000 ms, default 60,000; cleanup has a separate 10-second budget |
| `stop_on_failure` | default true; false continues assertion failures, not unsafe reads |
| `restore_inputs` | default true; restores levers, not downstream memory or piston effects |
| `trace` | default false; true requires complete tick-trace coverage through the last observation |

Inputs change sequentially. For clocked circuits, hold the clock inactive during data changes and supply an explicit clock sequence. The settling delay is not a proof of stability. Unknown/unloaded values, changed definitions/session, backwards ticks or five seconds without advancing ticks stop the run.

## results and recovery

Read `status`, completed/total counts, `restore` and trace coverage together. Status can be `running`, `passed`, `failed`, `cancelled`, `timed_out`, `aborted` or `interrupted`. Cancellation is a request; wait for its terminal receipt. A partial run with passing cases is not a passing experiment.

CLI exit codes: 0 passed, 2 failed/incomplete, 1 setup/usage error, 130 interrupted. Use `node scripts/circuit-test-cli.mjs` directly for JSON-only stdout. `--project` and `--config-dir` override local paths; authentication stays in private game configuration.

Detailed observations and input journals stay in `.minecraft-assistant/tests/runs/`; traces stay in `.minecraft-assistant/circuits/`. Status returns a bounded summary. Archive completed evidence before the 128-job history limit. Timing and JSON-byte counters are not model-token or billing measurements.

Ctrl-C/SIGTERM requests cancellation and bounded restoration. A killed process leaves its journal and writer lock. Inspect the exact saved session, current inputs and owner before recovery; unexpected changes block restoration. Never steal a lock merely because its process died: [lifecycle operations](COMMAND_CENTRE.md) may still be queued. There is no automatic world replay.

Keep the world unpaused and all circuit chunks ticking. End-of-tick traces can miss shorter pulses. Repeat the finished computer's demonstration in unmodified Minecraft.
