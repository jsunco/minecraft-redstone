# vanilla ripple adder

A four-bit arithmetic showcase for the bridge, separate from the planned programmable GPU. Nine levers select two unsigned four-bit operands and an optional carry-in. Four sum lamps and one overflow lamp show the five-bit result. Torches, dust and repeaters calculate it in the world; the local runner only changes inputs and checks an independent `a + b + carry` oracle.

Each slice uses two four-NAND XOR networks:

```text
x       = a xor b
sum     = x xor carry_in
carry   = (a and b) or (x and carry_in)
```

The four slices share only their carry connections. Raised paths use separate columns to cross other signals without joining them. This is an intentionally spread-out teaching/debugging layout, not a claim of a compact or fast Minecraft adder.

## generate a plan

```sh
node examples/ripple-adder.mjs /tmp/adder-plan 0,64,0
```

The coordinate is the first input lever. The command writes JSON files and does not connect to Minecraft. `build-tiles.json` contains 30 bounded region/plan pairs. Reserve and inspect the entire generated bounding box first: **applying the plans clears that area**. Use `build_region`, `build_plan`, preview and apply for each tile in file order. They use normal backup and readback protections. Use one dedicated persisted construction journal so previous experiments do not consume the 32-region allowance.

`circuit.json` names the five lamps as a little-endian output bus. Register it, then run the eight generated case files using the [local runner](../docs/TEST_RUNNER.md):

```sh
node scripts/circuit-test-cli.mjs run --spec /tmp/adder-plan/cases-1.json
```

Repeat for `cases-2.json` through `cases-8.json`. Together they cover all 256 pairs from 0+0 to 15+15 with carry-in held low. Each case waits 100 observed game ticks, and each file has 32 cases so it fits the runner's tick and wall-time limits. At 20 TPS these runs take several minutes per file. Keep simulation running. Inputs restore after each file; trace evidence stays local.

The single-bit prototype additionally tests all eight combinations including carry-in. The exhaustive four-bit operand suite does not by itself cover every arbitrary input-transition sequence, clocked state, or pulses occurring entirely within one tick. Final validation of the eventual computer in unmodified Minecraft is a separate milestone.
