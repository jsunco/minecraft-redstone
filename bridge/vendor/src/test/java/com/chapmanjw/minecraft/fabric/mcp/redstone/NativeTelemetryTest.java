package com.chapmanjw.minecraft.fabric.mcp.redstone;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

/** Tests wire contracts and lifecycle using a controlled world-read seam; no claims of in-game validation. */
class NativeTelemetryTest {
    private static final List<NativeTelemetry.Point> POINTS = List.of(new NativeTelemetry.Point(-1,64,3));
    private static TickRecorder.State state(String power) { return new TickRecorder.State("loaded","minecraft:redstone_wire",Map.of("power",power)); }
    private static final class Fixture {
        final AtomicLong tick = new AtomicLong(100);
        final AtomicInteger reads = new AtomicInteger();
        final AtomicReference<List<TickRecorder.State>> states = new AtomicReference<>(List.of(state("15")));
        final NativeTelemetry nativeTelemetry = new NativeTelemetry(new ObjectMapper(), tick::get, () -> {}, (dimension, points, properties) -> {
            reads.incrementAndGet(); return states.get();
        });
    }
    @Test void batchHasOneReadExactPropertiesCoordinatesAndFreshSession() {
        var f = new Fixture();
        var out = f.nativeTelemetry.batch("minecraft:overworld",POINTS,Set.of());
        assertEquals(1,f.reads.get()); assertTrue(out.get("atomic").asBoolean());
        assertEquals(100,out.get("server_tick").asLong()); assertEquals("server_task",out.get("phase").asText());
        var row = out.get("states").get(0); assertEquals(-1,row.get("position").get("x").intValue());
        assertEquals("15",row.get("properties").get("power").asText()); assertEquals("loaded",row.get("status").asText());
        assertEquals(f.nativeTelemetry.sessionId(),out.get("session_id").asText());
        assertNotEquals(new Fixture().nativeTelemetry.sessionId(),f.nativeTelemetry.sessionId());
    }
    @Test void tickSamplingPollStopAndDiscardHaveStableWireContract() {
        var f = new Fixture(); var start=f.nativeTelemetry.start("minecraft:overworld",POINTS,Set.of(),2,16);
        String id=start.get("watch_id").asText();
        assertEquals("15",start.get("initial_states").get(0).get("properties").get("power").asText());
        f.states.set(List.of(state("0"))); f.tick.incrementAndGet(); f.nativeTelemetry.onEndTick();
        var poll=f.nativeTelemetry.poll(id,0,5); var entry=poll.get("entries").get(0);
        assertEquals(101,entry.get("tick").longValue()); assertEquals(1,entry.get("seq").longValue());
        assertEquals("0",entry.get("states").get(0).get("properties").get("power").asText());
        assertEquals(poll,f.nativeTelemetry.poll(id,0,5));
        f.tick.incrementAndGet(); f.nativeTelemetry.onEndTick();
        assertFalse(f.nativeTelemetry.poll(id,1,5).get("active").asBoolean());
        assertEquals("duration_reached",f.nativeTelemetry.stop(id,false).get("end_reason").asText());
        assertTrue(f.nativeTelemetry.stop(id,true).get("discarded").asBoolean());
        assertThrows(IllegalArgumentException.class,()->f.nativeTelemetry.poll(id,0,1));
    }
    @Test void unloadedHasNoInventedIdAndOverflowHasRecoveryBaseline() {
        var f = new Fixture(); String id=f.nativeTelemetry.start("minecraft:overworld",POINTS,Set.of(),50,16).get("watch_id").asText();
        f.states.set(List.of(new TickRecorder.State("unloaded",null,Map.of()))); f.tick.incrementAndGet(); f.nativeTelemetry.onEndTick();
        var row=f.nativeTelemetry.poll(id,0,5).get("entries").get(0).get("states").get(0);
        assertEquals("unloaded",row.get("status").asText()); assertFalse(row.has("id"));
        for(int i=0;i<20;i++) { f.states.set(List.of(state(String.valueOf(i%16)))); f.tick.incrementAndGet(); f.nativeTelemetry.onEndTick(); }
        var overflow=f.nativeTelemetry.poll(id,0,512); assertTrue(overflow.get("gap").asBoolean());
        assertTrue(overflow.get("entries").isEmpty()); assertEquals("3",overflow.get("recovery_states").get(0).get("properties").get("power").asText());
        assertEquals(f.tick.get(),overflow.get("recovery_tick").asLong());
    }
    @Test void boundsThreadCheckAndClosePreventUnsafeReads() {
        var f=new Fixture();
        assertThrows(IllegalArgumentException.class,()->f.nativeTelemetry.start("minecraft:overworld",POINTS,Set.of(),0,16));
        assertEquals(0,f.reads.get());
        for(int i=0;i<8;i++) f.nativeTelemetry.start("minecraft:overworld",POINTS,Set.of(),1,16);
        assertThrows(IllegalStateException.class,()->f.nativeTelemetry.start("minecraft:overworld",POINTS,Set.of(),1,16));
        assertEquals(8,f.reads.get()); f.nativeTelemetry.close(); assertTrue(f.nativeTelemetry.list().get("watches").isEmpty());
        var denied=new NativeTelemetry(new ObjectMapper(),()->0,()->{throw new IllegalStateException("wrong thread");},(d,p,s)->{fail("Read on wrong thread"); return List.of();});
        assertThrows(IllegalStateException.class,()->denied.batch("minecraft:overworld",POINTS,Set.of()));
    }
    @Test void activePointBudgetIsReleasedOnStopWhileRetainedLogsRemainBounded() {
        AtomicLong tick = new AtomicLong(100);
        AtomicInteger reads = new AtomicInteger();
        var telemetry = new NativeTelemetry(new ObjectMapper(), tick::get, () -> {}, (dimension, points, properties) -> {
            reads.incrementAndGet();
            return points.stream().map(point -> state("0")).toList();
        });
        var points = java.util.stream.IntStream.range(0,64).mapToObj(i -> new NativeTelemetry.Point(i,64,0)).toList();
        var first = telemetry.start("minecraft:overworld",points,Set.of(),10,16).get("watch_id").asText();
        for(int i=0;i<3;i++) telemetry.start("minecraft:overworld",points,Set.of(),10,16);
        assertThrows(IllegalStateException.class,()->telemetry.start("minecraft:overworld",POINTS,Set.of(),10,16));
        assertEquals(4,reads.get(),"A rejected watch must not read the world");
        telemetry.stop(first,false);
        telemetry.start("minecraft:overworld",points,Set.of(),10,16);
        assertEquals(5,telemetry.list().get("watches").size(),"Stopped logs remain available");
        tick.addAndGet(10); telemetry.onEndTick();
        for(int i=0;i<3;i++) telemetry.start("minecraft:overworld",POINTS,Set.of(),10,16);
        assertThrows(IllegalStateException.class,()->telemetry.start("minecraft:overworld",POINTS,Set.of(),10,16));
        telemetry.stop(first,true);
        telemetry.start("minecraft:overworld",POINTS,Set.of(),10,16);
        assertEquals(8,telemetry.list().get("watches").size());
        telemetry.close();
        assertThrows(IllegalArgumentException.class,()->telemetry.poll(first,0,1));
    }

}
