# hidden signal dips

The September 27, 2026 OR experiment passed **64 settled-output cases**, but its tick trace captured **five one-tick wire dips**. At relative tick 54 the wire fell from power 12 to 0, then returned at 55 while the lamp stayed lit. Inputs were written sequentially; this was a switching transient, not a wrong settled OR result.

An offline replay sampling every 20 ticks at phase zero missed 13 of 20 complete low intervals, including all five one-tick dips. Other phases missed 11–15 intervals. These are replays of recorded samples, not a new live polling benchmark or exact pulse-duration measurements.

[Anonymous trace and replay data](assets/timing-trace.json) · [waveform](assets/timing-trace.svg) · [recording tools](CIRCUIT_TOOLS.md)

The trace had no reported gaps. End-of-tick recording can still miss pulses within a tick. [Current status and limits](VERIFICATION.md).
