package com.chapmanjw.minecraft.fabric.mcp.redstone;

import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.chapmanjw.minecraft.fabric.mcp.config.Config;
import com.chapmanjw.minecraft.fabric.mcp.protocol.ToolContext;
import com.chapmanjw.minecraft.fabric.mcp.tools.annotations.McpTool;
import com.chapmanjw.minecraft.fabric.mcp.tools.ToolRegistration;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class AdminControlTest {
    static final ObjectMapper MAPPER = new ObjectMapper();
    static final class Fake implements AdminControl.Backend {
        int calls, snapshots; String command, dimension; double rate = 20;
        AdminControl.Result result = new AdminControl.Result(true,1,1,List.of("Done"),List.of(),false);
        public ObjectNode status(String dimension) {
            snapshots++;
            if (!dimension.equals("minecraft:overworld") && !dimension.equals("minecraft:the_nether"))
                throw new IllegalArgumentException("Unknown dimension");
            return MAPPER.createObjectNode().put("world_name","GPU Lab").put("server_tick",800)
                    .put("world_game_time",2700000).put("dimension",dimension).put("tick_rate",rate);
        }
        public AdminControl.Result execute(String command, String dimension) {
            calls++; this.command=command; this.dimension=dimension;
            if (command.startsWith("tick rate ")) rate=Double.parseDouble(command.substring(10));
            return result;
        }
    }
    static AdminControl control(Fake fake, AtomicBoolean active) {
        return new AdminControl(MAPPER,"session",()->{},active::get,fake);
    }
    @Test void statusSeparatesClocksAndNamesWorldWithoutExecuting() {
        var fake=new Fake(); var out=control(fake,new AtomicBoolean(true)).status();
        assertEquals("session",out.path("session_id").asText()); assertEquals("GPU Lab",out.path("world_name").asText());
        assertEquals(800,out.path("server_tick").asInt()); assertEquals(2700000,out.path("world_game_time").asInt());
        assertTrue(out.path("active_recorders").asBoolean()); assertEquals(0,fake.calls);
    }
    @Test void expectedSessionAndRecorderGuardRunBeforeBackend() {
        var fake=new Fake(); var active=new AtomicBoolean(); var control=control(fake,active);
        assertThrows(IllegalArgumentException.class,()->control.command("old","tick rate 100",null));
        assertEquals(0,fake.snapshots); assertEquals(0,fake.calls);
        active.set(true);
        assertThrows(IllegalStateException.class,()->control.command("session","execute run tick rate 100",null));
        assertEquals(0,fake.calls); assertEquals(0,fake.snapshots);
    }
    @Test void commandPreservesFailureFeedbackAndExplicitDimension() {
        var fake=new Fake(); fake.result=new AdminControl.Result(false,1,0,List.of("Failed to find block"),List.of("command failed"),false);
        var out=control(fake,new AtomicBoolean()).command("session"," /data get block 1 2 3 ","minecraft:the_nether");
        assertEquals("data get block 1 2 3",fake.command); assertEquals("minecraft:the_nether",fake.dimension);
        assertFalse(out.path("success").asBoolean()); assertEquals(4,out.path("permission_level").asInt());
        assertEquals("command failed",out.path("errors").get(0).asText()); assertEquals(2,fake.snapshots);
    }
    @Test void tickMutationReportsBeforeAndActualAfter() {
        var fake=new Fake(); var out=control(fake,new AtomicBoolean()).tickControl("session","rate",100.0,null);
        assertEquals("tick rate 100.0",fake.command); assertEquals(20,out.path("before").path("tick_rate").asDouble());
        assertEquals(100,out.path("tick_rate").asDouble()); assertTrue(out.path("success").asBoolean());
    }
    @Test void supportedActionsCreateOnlyBoundedVanillaCommands() {
        assertEquals("tick freeze",AdminControl.tickCommand("freeze",null,null));
        assertEquals("tick unfreeze",AdminControl.tickCommand("unfreeze",null,null));
        assertEquals("tick step 12t",AdminControl.tickCommand("step",null,12));
        assertEquals("tick sprint 1000000t",AdminControl.tickCommand("sprint",null,1000000));
        assertEquals("tick step stop",AdminControl.tickCommand("step_stop",null,null));
        assertEquals("tick sprint stop",AdminControl.tickCommand("sprint_stop",null,null));
        assertEquals("tick rate 1.0",AdminControl.tickCommand("rate",1.0,null));
        assertEquals("tick rate 10000.0",AdminControl.tickCommand("rate",10000.0,null));
    }
    @Test void malformedTickInputsCannotReachExecution() {
        var fake=new Fake(); var control=control(fake,new AtomicBoolean());
        for(double rate : new double[]{Double.NaN,Double.POSITIVE_INFINITY,0,10000.1})
            assertThrows(IllegalArgumentException.class,()->control.tickControl("session","rate",rate,null));
        for(int ticks : new int[]{0,-1,1000001})
            assertThrows(IllegalArgumentException.class,()->control.tickControl("session","step",null,ticks));
        assertThrows(IllegalArgumentException.class,()->control.tickControl("session","rate",20.0,1));
        assertThrows(IllegalArgumentException.class,()->control.tickControl("session","freeze",20.0,null));
        assertThrows(IllegalArgumentException.class,()->control.tickControl("session","freeze",null,1));
        assertThrows(IllegalArgumentException.class,()->control.tickControl("session","step",null,null));
        assertThrows(IllegalArgumentException.class,()->control.tickControl("session","stop",null,null));
        assertEquals(0,fake.calls); assertEquals(0,fake.snapshots);
    }
    @Test void malformedCommandAndUnknownDimensionCannotExecute() {
        var fake=new Fake(); var control=control(fake,new AtomicBoolean());
        for(String command : new String[]{"", " / ", "say a\nsay b", "say a\rb", "say a\0b", "x".repeat(32769)})
            assertThrows(IllegalArgumentException.class,()->control.command("session",command,null));
        assertThrows(IllegalArgumentException.class,()->control.command("session","say a","absent:dimension"));
        assertEquals(0,fake.calls);
    }
    @Test void threadGuardRejectsBeforeWorldAccess() {
        var fake=new Fake(); var count=new AtomicInteger();
        var control=new AdminControl(MAPPER,"session",()->{count.incrementAndGet();throw new IllegalStateException("wrong thread");},()->false,fake);
        assertThrows(IllegalStateException.class,control::status);
        assertThrows(IllegalStateException.class,()->control.command("session","list",null));
        assertEquals(2,count.get()); assertEquals(0,fake.snapshots); assertEquals(0,fake.calls);
    }
    static Config config(boolean auth,String token,String access,boolean readonly) {
        return new Config("127.0.0.1",8765,auth,token,false,List.of(),5000,600,1048576,100,100,"INFO",null,null,false,List.of(),List.of(),access,readonly);
    }
    static ToolContext context(Config config) { return new ToolContext(null,null,null,config,MAPPER,null,null); }
    @Test void authenticationAndExplicitAdminAreBothRequiredEvenOnDirectToolInvocation() {
        var args=MAPPER.createObjectNode().put("expected_session","session").put("command","list").put("action","freeze");
        for(Config config : List.of(config(false,"token","admin",false),config(true,null,"admin",false),
                config(true," ","admin",false),config(true,"token","write",false),config(true,"token","admin",true))) {
            assertThrows(IllegalStateException.class,()->new AdminTools.Command().execute(args,context(config)));
            assertThrows(IllegalStateException.class,()->new AdminTools.Status().execute(args,context(config)));
            assertThrows(IllegalStateException.class,()->new AdminTools.Tick().execute(args,context(config)));
        }
        assertDoesNotThrow(()->AdminTools.requireAuthenticatedAdmin(context(config(true,"token","admin",false))));
    }
    @Test void allThreeToolsAreRegisteredAsAdminAndHaveStrictSchemas() {
        for(var tool : List.of(new AdminTools.Command(),new AdminTools.Status(),new AdminTools.Tick())) {
            assertTrue(ToolRegistration.ALL_TOOL_CLASSES.contains(tool.getClass()));
            assertTrue(tool.getClass().getAnnotation(McpTool.class).admin());
            assertFalse(tool.inputSchema().path("additionalProperties").asBoolean());
        }
    }
    @Test void captureBoundsFeedbackAndRecordsCallbackFailureWithoutInventedSuccess() {
        var capture=new VanillaAdminBackend.Capture();
        capture.message("a".repeat(40000)); capture.message("overflow"); capture.result(false,0);
        var result=capture.finish();
        assertFalse(result.success()); assertTrue(result.outputTruncated()); assertEquals(32768,result.feedback().get(0).length());
        assertFalse(result.errors().isEmpty()); assertEquals(1,result.callbackCount());
        var unknown=new VanillaAdminBackend.Capture().finish(); assertFalse(unknown.success()); assertEquals(0,unknown.callbackCount()); assertFalse(unknown.errors().isEmpty());
    }
    @Test void captureCombinesActualCallbackResultsIncludingZeroAndMixedFailure() {
        var capture=new VanillaAdminBackend.Capture(); capture.result(true,0); capture.result(true,3);
        assertTrue(capture.finish().success()); assertEquals(3,capture.finish().result()); assertEquals(2,capture.finish().callbackCount());
        capture.result(false,0); assertFalse(capture.finish().success());
    }
    @Test void failureFeedbackOverridesEarlierSuccessEvenWithoutFailureCallback() {
        var capture=new VanillaAdminBackend.Capture(); capture.result(true,3);
        assertTrue(capture.acceptsFailure()); capture.message("Vanilla exception feedback");
        var result=capture.finish(); assertFalse(result.success());
        assertEquals(List.of("Vanilla exception feedback"),result.errors()); assertEquals(1,result.callbackCount());
    }
}
