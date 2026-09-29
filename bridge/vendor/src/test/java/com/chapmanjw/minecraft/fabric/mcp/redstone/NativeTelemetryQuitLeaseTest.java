package com.chapmanjw.minecraft.fabric.mcp.redstone;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

/** Server-thread admission interleavings only; no live disconnect or Minecraft server is created. */
class NativeTelemetryQuitLeaseTest {
    private static final List<NativeTelemetry.Point> POINTS = List.of(new NativeTelemetry.Point(0,64,0));
    private static final class Fixture {
        final AtomicLong tick = new AtomicLong(10);
        final AtomicInteger reads = new AtomicInteger();
        final AtomicBoolean onThread = new AtomicBoolean(true);
        final NativeTelemetry telemetry = new NativeTelemetry(new ObjectMapper(), tick::get, () -> {
            if (!onThread.get()) throw new IllegalStateException("wrong thread");
        }, (dimension, points, properties) -> {
            reads.incrementAndGet();
            return List.of(new TickRecorder.State("loaded", "minecraft:lever", Map.of("powered", "false")));
        });
        String start() { return telemetry.start("minecraft:overworld", POINTS, Set.of(), 20, 16).get("watch_id").asText(); }
        Runnable acquire() { return telemetry.acquireQuitLease(telemetry.sessionId()); }
    }

    @Test void activeRecordingRefusesQuitWithoutStoppingOrDiscardingIt() {
        var f = new Fixture(); String id = f.start();
        assertThrows(IllegalStateException.class, f::acquire);
        assertTrue(f.telemetry.poll(id, 0, 16).get("active").asBoolean());
        assertEquals(1, f.reads.get());
        assertNotNull(f.start(), "Rejected quit must leave recorder admission open");
    }

    @Test void leaseSealsAdmissionBeforeAnyReadAndReleaseRestoresIt() {
        var f = new Fixture(); Runnable release = f.acquire();
        assertThrows(IllegalStateException.class, f::start);
        assertThrows(IllegalStateException.class, f::acquire);
        assertEquals(0, f.reads.get());
        release.run();
        assertNotNull(f.start());
        assertEquals(1, f.reads.get());
    }

    @Test void completedAndStoppedRetainedLogsRemainReadableDuringLease() {
        var f = new Fixture(); String completed = f.start();
        f.tick.addAndGet(20); f.telemetry.onEndTick();
        String stopped = f.start(); f.telemetry.stop(stopped, false);
        Runnable release = f.acquire();
        assertEquals("duration_reached", f.telemetry.poll(completed, 0, 16).get("end_reason").asText());
        assertEquals("stopped", f.telemetry.poll(stopped, 0, 16).get("end_reason").asText());
        assertEquals(2, f.telemetry.list().get("watches").size());
        assertTrue(f.telemetry.stop(stopped, true).get("discarded").asBoolean());
        release.run();
        assertNotNull(f.start());
    }

    @Test void staleReleaseCannotUnsealAnotherQuitAttempt() {
        var f = new Fixture(); Runnable first = f.acquire(); first.run();
        Runnable second = f.acquire(); first.run(); first.run();
        assertThrows(IllegalStateException.class, f::start);
        assertEquals(0, f.reads.get());
        second.run(); assertNotNull(f.start());
    }

    @Test void closePermanentlySealsAdmissionEvenAfterRelease() {
        var f = new Fixture(); Runnable release = f.acquire();
        f.telemetry.close(); release.run();
        assertThrows(IllegalStateException.class, f::start);
        assertThrows(IllegalStateException.class, f::acquire);
        assertTrue(f.telemetry.list().get("watches").isEmpty());
        assertEquals(0, f.reads.get());
    }

    @Test void wrongThreadAndWrongSessionCannotAcquireOrRelease() {
        var f = new Fixture();
        assertThrows(IllegalStateException.class, () -> f.telemetry.acquireQuitLease(null));
        assertThrows(IllegalStateException.class, () -> f.telemetry.acquireQuitLease("foreign-session"));
        f.onThread.set(false); assertThrows(IllegalStateException.class, f::acquire);
        f.onThread.set(true); Runnable release = f.acquire();
        f.onThread.set(false); assertThrows(IllegalStateException.class, release::run);
        assertThrows(IllegalStateException.class, f::start);
        f.onThread.set(true); assertThrows(IllegalStateException.class, f::start);
        assertEquals(0, f.reads.get());
        release.run(); assertNotNull(f.start());
    }

    @Test void publicEntryRefusesAbsentServerInsteadOfAdoptingActiveSession() {
        assertThrows(IllegalStateException.class, () -> NativeTelemetry.acquireQuitLease(null, "session"));
    }
}
