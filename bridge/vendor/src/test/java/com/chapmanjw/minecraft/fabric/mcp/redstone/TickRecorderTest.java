package com.chapmanjw.minecraft.fabric.mcp.redstone;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class TickRecorderTest {
    private TickRecorder.State state(int power) { return new TickRecorder.State("loaded", "minecraft:redstone_wire", Map.of("power", String.valueOf(power))); }
    @Test void capturesEachTickTransitionAndRetriesWithoutDraining() {
        TickRecorder r = new TickRecorder(List.of(state(0)),10,10,16);
        r.sample(11,List.of(state(15))); r.sample(12,List.of(state(0))); r.sample(13,List.of(state(0)));
        var first = r.poll(0,1); assertEquals(1,first.nextSeq()); assertEquals(11,first.entries().getFirst().tick());
        assertEquals(first,r.poll(0,1)); assertEquals(2,r.poll(1,8).nextSeq()); assertEquals(0,r.poll(2,8).entries().size());
        assertEquals(13,r.lastTick());
    }
    @Test void overflowRequiresRecoveryBaseline() {
        TickRecorder r = new TickRecorder(List.of(state(0)),0,100,16);
        for(int tick=1;tick<=20;tick++) r.sample(tick,List.of(state(tick%16)));
        var page=r.poll(0,512); assertTrue(page.gap()); assertEquals(4,page.droppedTotal());
        assertTrue(page.entries().isEmpty()); assertEquals(20,page.nextSeq()); assertEquals(List.of(state(4)),page.recoveryStates());
        assertFalse(r.poll(4,512).gap());
    }
    @Test void unloadedAndReloadedAreTransitionsNotFakeAir() {
        TickRecorder r = new TickRecorder(List.of(state(4)),0,20,16);
        r.sample(1,List.of(new TickRecorder.State("unloaded",null,Map.of()))); r.sample(2,List.of(state(4)));
        assertEquals("unloaded",r.poll(0,10).entries().getFirst().changes().get(0).status());
        assertEquals(2,r.poll(0,10).entries().size());
    }
    @Test void explicitSamplingGapsAndDurationAreReported() {
        TickRecorder r = new TickRecorder(List.of(state(0)),5,3,16);
        r.sample(8,List.of(state(0))); assertFalse(r.active()); assertEquals("duration_reached",r.endReason());
        assertEquals(2,r.poll(0,5).entries().getFirst().missedTicks());
        r.sample(9,List.of(state(5))); assertEquals(List.of(state(0)),r.states());
    }
    @Test void boundsAndFutureCursorReject() {
        assertThrows(IllegalArgumentException.class,()->new TickRecorder(List.of(state(0)),0,0,16));
        TickRecorder r=new TickRecorder(List.of(state(0)),0,1,16);
        assertThrows(IllegalArgumentException.class,()->r.poll(1,5));
        assertThrows(IllegalArgumentException.class,()->r.poll(0,0));
        r.sample(-1,List.of(state(0))); assertEquals("clock_reset",r.endReason());
    }
}
