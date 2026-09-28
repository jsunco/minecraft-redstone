package com.chapmanjw.minecraft.fabric.mcp.redstone;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/** Bounded, non-destructive cursor log. The owner calls sample once at each end-server-tick. */
public final class TickRecorder {
    public record State(String status, String id, Map<String, String> properties) {
        public State { properties = Map.copyOf(properties); }
    }
    public record Entry(long seq, long tick, Map<Integer, State> changes, long missedTicks) {
        public Entry { changes = Map.copyOf(changes); }
    }
    public record Page(List<Entry> entries, long nextSeq, long latestSeq, long oldestSeq,
                       long droppedTotal, boolean gap, List<State> recoveryStates) {}

    private final Deque<Entry> entries = new ArrayDeque<>();
    private final int capacity;
    private final long startedTick;
    private final long durationTicks;
    private List<State> states;
    private long lastTick;
    private long latestSeq;
    private long dropped;
    private boolean active = true;
    private String endReason;

    public TickRecorder(List<State> initial, long start, long duration, int capacity) {
        if (initial.isEmpty() || initial.size() > 64) throw new IllegalArgumentException("1..64 positions required");
        if (duration < 1 || duration > 12000) throw new IllegalArgumentException("duration_ticks must be 1..12000");
        if (capacity < 16 || capacity > 4096) throw new IllegalArgumentException("buffer_capacity must be 16..4096");
        this.states = List.copyOf(initial);
        this.lastTick = start;
        this.startedTick = start;
        this.durationTicks = duration;
        this.capacity = capacity;
    }

    public void sample(long tick, List<State> next) {
        if (!active) return;
        if (next.size() != states.size()) throw new IllegalArgumentException("Position count changed");
        if (tick < lastTick) { stop("clock_reset"); return; }
        long missed = Math.max(0, tick - lastTick - 1);
        Map<Integer, State> changes = new TreeMap<>();
        for (int i = 0; i < states.size(); i++) if (!states.get(i).equals(next.get(i))) changes.put(i, next.get(i));
        if (!changes.isEmpty() || missed > 0) {
            if (entries.size() == capacity) { entries.removeFirst(); dropped++; }
            entries.addLast(new Entry(++latestSeq, tick, changes, missed));
        }
        states = List.copyOf(next);
        lastTick = tick;
        if (tick - startedTick >= durationTicks) stop("duration_reached");
    }

    public Page poll(long after, int max) {
        if (after < 0 || after > latestSeq) throw new IllegalArgumentException("after_seq is outside this recorder's sequence range");
        if (max < 1 || max > 512) throw new IllegalArgumentException("max_entries must be 1..512");
        long oldest = entries.isEmpty() ? latestSeq + 1 : entries.getFirst().seq();
        boolean gap = after < oldest - 1;
        // A gap requires an explicit new baseline. Do not return deltas that look continuous.
        if (gap) return new Page(List.of(), latestSeq, latestSeq, oldest, dropped, true, states);
        List<Entry> page = new ArrayList<>();
        long cursor = after;
        for (Entry entry : entries) {
            if (entry.seq() <= after) continue;
            page.add(entry); cursor = entry.seq();
            if (page.size() == max) break;
        }
        return new Page(List.copyOf(page), cursor, latestSeq, oldest, dropped, false, List.of());
    }
    public void stop(String reason) { if (active) { active = false; endReason = reason; } }
    public boolean active() { return active; }
    public String endReason() { return endReason; }
    public long lastTick() { return lastTick; }
    public long startedTick() { return startedTick; }
    public long durationTicks() { return durationTicks; }
    public List<State> states() { return states; }
}
