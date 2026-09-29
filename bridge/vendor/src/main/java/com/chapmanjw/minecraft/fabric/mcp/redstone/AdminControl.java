package com.chapmanjw.minecraft.fabric.mcp.redstone;

import java.util.List;
import java.util.function.BooleanSupplier;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

/** Session-bound administrative operations. Authentication is enforced at the tool boundary. */
public final class AdminControl {
    public static final int MAX_COMMAND_LENGTH = 32768;
    public static final int MAX_TICKS = 1000000;
    public record Result(boolean success, int callbackCount, long result, List<String> feedback,
                         List<String> errors, boolean outputTruncated) {}
    interface Backend {
        ObjectNode status(String dimension);
        Result execute(String command, String dimension);
    }
    private final ObjectMapper mapper;
    private final String session;
    private final Runnable threadCheck;
    private final BooleanSupplier activeWatches;
    private final Backend backend;

    AdminControl(ObjectMapper mapper, String session, Runnable threadCheck,
                 BooleanSupplier activeWatches, Backend backend) {
        this.mapper = mapper; this.session = session; this.threadCheck = threadCheck;
        this.activeWatches = activeWatches; this.backend = backend;
    }
    public ObjectNode status() { return status("minecraft:overworld"); }
    private ObjectNode status(String dimension) {
        threadCheck.run();
        ObjectNode out = backend.status(dimension);
        out.put("session_id", session);
        out.put("phase", "server_task");
        out.put("active_recorders", activeWatches.getAsBoolean());
        return out;
    }
    public ObjectNode command(String expectedSession, String command, String dimension) {
        threadCheck.run();
        if (expectedSession == null || !session.equals(expectedSession))
            throw new IllegalArgumentException("expected_session does not match the active server session");
        String normalized = normalizeCommand(command);
        if (dimension == null || dimension.isBlank()) dimension = "minecraft:overworld";
        if (activeWatches.getAsBoolean())
            throw new IllegalStateException("Stop active native recorders before administrative commands");
        ObjectNode before = status(dimension); // validates dimension before executing
        Result result = backend.execute(normalized, dimension);
        ObjectNode out = status(dimension);
        out.put("command", normalized); out.put("permission_level", 4);
        out.put("success", result.success()); out.put("callback_count", result.callbackCount());
        out.put("result", result.result()); out.set("feedback", mapper.valueToTree(result.feedback()));
        out.set("errors", mapper.valueToTree(result.errors())); out.put("output_truncated", result.outputTruncated());
        out.set("before", before);
        return out;
    }
    static String normalizeCommand(String input) {
        if (input == null) throw new IllegalArgumentException("command is required");
        if (input.length() > MAX_COMMAND_LENGTH || input.indexOf('\n') >= 0 || input.indexOf('\r') >= 0 || input.indexOf('\0') >= 0)
            throw new IllegalArgumentException("command must be a single line of at most " + MAX_COMMAND_LENGTH + " characters");
        String command = input.strip();
        if (command.startsWith("/")) command = command.substring(1);
        if (command.isBlank()) throw new IllegalArgumentException("command must not be empty");
        return command;
    }
    public ObjectNode tickControl(String expectedSession, String action, Double rate, Integer ticks) {
        String command = tickCommand(action, rate, ticks);
        ObjectNode out = command(expectedSession, command, "minecraft:overworld");
        out.put("action", action);
        return out;
    }
    static String tickCommand(String action, Double rate, Integer ticks) {
        if (action == null) throw new IllegalArgumentException("action is required");
        if ("rate".equals(action)) {
            if (rate == null || !Double.isFinite(rate) || rate < 1 || rate > 10000 || ticks != null)
                throw new IllegalArgumentException("rate requires finite rate 1..10000 and no ticks");
            return "tick rate " + Float.toString(rate.floatValue());
        }
        if (rate != null) throw new IllegalArgumentException("rate is only valid for action=rate");
        if ("step".equals(action) || "sprint".equals(action)) {
            if (ticks == null || ticks < 1 || ticks > MAX_TICKS)
                throw new IllegalArgumentException("step/sprint requires ticks 1.." + MAX_TICKS);
            return "tick " + action + " " + ticks + "t";
        }
        if (ticks != null) throw new IllegalArgumentException("ticks is only valid for step/sprint");
        return switch (action) {
            case "freeze", "unfreeze" -> "tick " + action;
            case "step_stop" -> "tick step stop";
            case "sprint_stop" -> "tick sprint stop";
            default -> throw new IllegalArgumentException("Unknown tick action");
        };
    }
}
