package com.chapmanjw.minecraft.fabric.mcp.tools.client;

import static org.junit.jupiter.api.Assertions.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.*;

class ClientAdminValidationTest {
    @TempDir Path temp;
    @Test void exactSessionAndWorldBothRequired() {
        ClientAdminValidation.expected("none","","none","");
        ClientAdminValidation.expected("id","TinyGPU Build","id","TinyGPU Build");
        assertThrows(IllegalStateException.class,()->ClientAdminValidation.expected("old","TinyGPU Build","new","TinyGPU Build"));
        assertThrows(IllegalStateException.class,()->ClientAdminValidation.expected("id","TinyGPU Build","id","Other"));
        assertThrows(IllegalStateException.class,()->ClientAdminValidation.expected("none","","id","TinyGPU Build"));
    }
    @Test void boundedOptionsBeforeAnyMutation() {
        ClientAdminValidation.optionBounds(2,5,30);
        ClientAdminValidation.optionBounds(32,32,260);
        ClientAdminValidation.optionBounds(null,null,null);
        for (int x:new int[]{-1,0,1,33,100}) assertThrows(IllegalArgumentException.class,()->ClientAdminValidation.optionBounds(x,null,null));
        for (int x:new int[]{0,2,4,33}) assertThrows(IllegalArgumentException.class,()->ClientAdminValidation.optionBounds(null,x,null));
        for (int x:new int[]{0,9,11,61,261}) assertThrows(IllegalArgumentException.class,()->ClientAdminValidation.optionBounds(null,null,x));
    }
    @Test void namesCannotEscapeOrBeAmbiguous() {
        assertEquals("TinyGPU Workshop",ClientAdminValidation.worldName("TinyGPU Workshop"));
        for(String x:new String[]{"","../Build","/tmp/test","a/b","a\\b"," world","world ",".","..","a".repeat(65)})
            assertThrows(IllegalArgumentException.class,()->ClientAdminValidation.worldName(x));
    }
    @Test void newSaveNeverOverwritesAndOpenRequiresSave() throws Exception {
        Path base=temp.toRealPath(); Path path=ClientAdminValidation.destination(base,"New World",true);
        assertFalse(Files.exists(path));
        Files.createDirectory(path);
        assertThrows(IllegalStateException.class,()->ClientAdminValidation.destination(base,"New World",true));
        assertThrows(IllegalStateException.class,()->ClientAdminValidation.destination(base,"New World",false));
        Files.writeString(path.resolve("level.dat"),"test");
        assertEquals(path,ClientAdminValidation.destination(base,"New World",false));
    }
    @Test void saveSymlinksAreRejected() throws Exception {
        Path base=temp.toRealPath(),real=Files.createDirectory(base.resolve("Real"));
        Files.writeString(real.resolve("level.dat"),"test");
        Files.createSymbolicLink(base.resolve("Link"),real);
        assertThrows(IllegalStateException.class,()->ClientAdminValidation.destination(base,"Link",false));
        assertThrows(IllegalStateException.class,()->ClientAdminValidation.destination(base,"Link",true));
        Files.createSymbolicLink(base.resolve("Base"),base);
        assertThrows(IllegalStateException.class,()->ClientAdminValidation.destination(base.resolve("Base"),"Another",true));
    }
}
