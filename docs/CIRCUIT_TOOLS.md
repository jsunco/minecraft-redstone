# Signals, buses and tick traces

Register named circuits with circuit_register. Coordinates identify blocks whose properties carry signals. Dust power0 is off and1–15 is on; boolean lit/powered/open/triggered decode false/true. Optional active_value uses exact comparison. Missing, invalid and unloaded values stay unknown.

```json
{
  "id":"adder","dimension":"minecraft:overworld",
  "signals":[
    {"name":"sum0","position":{"x":10,"y":1,"z":10},"property":"power"},
    {"name":"sum1","position":{"x":10,"y":1,"z":12},"property":"power"},
    {"name":"carry","position":{"x":10,"y":1,"z":14},"property":"lit"}
  ],
  "buses":[{"name":"sum","bits":["sum0","sum1"]}]
}
```

The first bus bit is least significant: [1,0]means1; [0,1]means2. Up to64signals,16buses,32bits per bus. Any unknown bit makes the bus value unknown. Registration never places blocks.

circuit_observe {"id":"adder","expect":{"sum":2,"carry":0}} reads positions in one server task, returns session/tick, and tests expectations. Unknown outputs fail assertions. It does not activate inputs or prove settling. Observe advancing ticks and choose meaningful inputs.

## Recording

1. circuit_trace {"action":"start","id":"adder","duration_ticks":200} returns trace UUID and initial state.
2. Change circuit inputs through the agreed construction/input workflow.
3. circuit_trace {"action":"poll","trace_id":"<UUID>"} retrieves changes. Continue while has_more.
4. circuit_trace {"action":"stop","trace_id":"<UUID>"} ends early; poll again for final buffered changes.
5. circuit_trace {"action":"status"} recovers local circuit/trace summaries after context loss.

Native sampling is end_server_tick, not continuous within a tick. Initial reads are server tasks. Pulses wholly within one tick may be invisible. A paused server records no advancing time. Duration1–12,000ticks, up to64positions per capture. Native limits:8recorders,256total positions, bounded retained entries. Polls use nondestructive cursors.

Overflow yields full recovery state and explicit missing history, never invented edges. Server restart invalidates session-bound traces. Full pages remain as JSONL in <project>/.minecraft-assistant/circuits/. Model-facing summaries are bounded and report omissions; local artifacts are excluded from Git.

After a trace is inactive and polling reports `has_more:false`, use `circuit_trace {"action":"discard","trace_id":"<UUID>"}` to release its native recorder slot. Discard requires a persistent local artifact directory and refuses active or undrained traces. The saved circuit definition, final state, summary and full JSONL history remain available locally; later polls of that discarded trace return its saved final state without reading Minecraft. This makes room under the native eight-recorder limit without deleting recorded evidence.

Sampling is not a full logic simulator or proof of correct computation. Test zero, carry/overflow, hold/write/reset and program expectations. Repeat the completed machine's demonstration in vanilla Minecraft.
