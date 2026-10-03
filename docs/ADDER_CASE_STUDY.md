# four-bit adder

A 5,943-block vanilla ripple-carry adder passed all **256 operand pairs**, with carry-in zero, in **1,521.124 seconds**. Eight jobs each waited 100 advancing ticks per case, restored their inputs and retained complete traces. One carry transition settled at tick 86; a tick-64 snapshot would have been wrong.

Removing one carry wire made `1 + 1` return 0. The runner failed correctly, snapshot undo restored the wire, and six repair cases passed. This proves one-cell recovery, not whole-structure undo.

[All results](data/adder-validation.json) · [fault and repair](data/carry-fault-validation.json) · [recording](assets/adder-run.mp4) · [build example](../examples/ripple-adder.md)

The September 27, 2026 checks used Minecraft Java 26.3 with the Fabric helper. Redstone computed the answers. This covers one sequence of operand pairs, not all transitions or carry-in-one cases. It is not a completed GPU or final unmodified-Minecraft acceptance. [Current status](VERIFICATION.md).
