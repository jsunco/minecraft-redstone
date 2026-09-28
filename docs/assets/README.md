# captured evidence

`adder-overview.png` and `adder-run.mp4` show the real Minecraft Java 26.3 test world with the Fabric helper connected. Vanilla redstone calculates the outputs. The screenshot is a native client capture, not a render generated from the placement plan.

The video contains 52 native captures at approximately two frames per second. Capture-start intervals determine playback spacing; the final frame is held briefly. It is encoded as a 26.5-second H.264 video at 20 frames per second using duplicated frames, not motion interpolation. The Minecraft simulation was configured for 20 TPS. There is no audio or time acceleration.

The user authorized temporary character positioning for filming. Position and view were restored and checked afterward. This footage does not demonstrate the separate spectator controller.

The arithmetic result comes from [recorded test assertions](../ADDER_CASE_STUDY.md), not visual interpretation of the video. The [timing figure and anonymous dataset](../TIMING_CASE_STUDY.md) come from an earlier live OR-circuit trace. [Catalog measurements](catalog-metrics.json) describe this configured installation; [changing-circuit encoding](active-adder-encoding.json) describes equivalent selected observations, not model tokens.

The final clip runs 0+0, 15+1, 15+15 and reset-to-zero with 100-tick settling; all four filmed assertions passed. The full-size poster was captured separately with 15+15 settled to30, then the circuit was reset and the saved player view restored.
