# signals and traces

`circuit_register` names existing blocks; it does not place them. Dust power 0 is off and 1–15 is on. Boolean properties decode as 0/1; `active_value` requests an exact comparison. Missing or unloaded values stay unknown.

```json
{
  "id":"adder","dimension":"minecraft:overworld",
  "signals":[
    {"name":"sum0","position":{"x":10,"y":64,"z":10},"property":"power"},
    {"name":"sum1","position":{"x":10,"y":64,"z":12},"property":"power"}
  ],
  "buses":[{"name":"sum","bits":["sum0","sum1"]}]
}
```

Use inspected coordinates. Bus bits are least-significant first: `[1,0]` means 1. Limits: 64 signals, 16 buses, 32 bits per bus. An unknown bit makes the bus unknown.

`circuit_observe {"id":"adder","expect":{"sum":2}}` reads one native server-task batch and checks expectations. Unknown outputs fail. Observation does not change inputs or prove settling; use the [test runner](TEST_RUNNER.md) for repeated cases.

## record

1. `circuit_trace {"action":"start","id":"adder","duration_ticks":200}` returns a trace ID.
2. Apply inputs, then `poll` with `trace_id`; continue while `has_more`.
3. `stop` with `trace_id`, then drain remaining pages.
4. Once inactive and drained, `discard` releases the native recorder slot and retains local evidence. `status` recovers trace summaries.

Duration is 1–12,000 ticks, with at most 64 positions per trace, eight retained native recorders and 256 active positions. Initial reads occur in a server task; subsequent samples occur at tick end. Paused ticks do not advance. Pulses entirely within a tick can be missed.

Overflow explicitly marks missing history and returns recovery state. A restart invalidates the session. Full JSONL remains in `.minecraft-assistant/circuits/`; discard requires persistent local storage. Never treat missing history as evidence that no pulse occurred.
