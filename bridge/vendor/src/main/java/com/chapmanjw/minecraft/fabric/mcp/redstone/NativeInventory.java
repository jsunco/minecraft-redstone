package com.chapmanjw.minecraft.fabric.mcp.redstone;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import net.minecraft.core.registries.Registries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.ItemStack;

/** Bounded read-only views: ordinary item identifiers/counts and optional component names, never component payloads. */
final class NativeInventory {
    private NativeInventory() {}
    static ObjectNode read(MinecraftServer server, ObjectMapper mapper, UUID uuid, boolean includeComponents) {
        var player = server.getPlayerList().getPlayer(uuid);
        ObjectNode out = mapper.createObjectNode(); out.put("player_uuid",uuid.toString());
        if (player == null) { out.put("status","offline"); return out; }
        out.put("status","online"); out.put("player_name",player.getGameProfile().name());
        out.put("selected_slot",player.getInventory().getSelectedSlot());
        ObjectNode main = out.putObject("main"); main.put("size",Inventory.INVENTORY_SIZE);
        ObjectNode slots = main.putObject("slots");
        for (int i=0;i<Inventory.INVENTORY_SIZE;i++) slots.set(String.valueOf(i),stack(server,mapper,player.getInventory().getItem(i),includeComponents));
        var ender = player.getEnderChestInventory();
        ObjectNode enderNode = out.putObject("ender_chest"); enderNode.put("size",ender.getContainerSize());
        ObjectNode enderSlots = enderNode.putObject("slots");
        for (int i=0;i<ender.getContainerSize();i++) enderSlots.set(String.valueOf(i),stack(server,mapper,ender.getItem(i),includeComponents));
        ObjectNode equipment = out.putObject("equipment");
        for (EquipmentSlot slot : EquipmentSlot.values()) equipment.set(slot.getName(),stack(server,mapper,player.getItemBySlot(slot),includeComponents));
        return out;
    }
    private static ObjectNode stack(MinecraftServer server, ObjectMapper mapper, ItemStack stack, boolean includeComponents) {
        ObjectNode out = mapper.createObjectNode(); out.put("empty",stack.isEmpty());
        var id = server.registryAccess().lookupOrThrow(Registries.ITEM).getKey(stack.getItem());
        out.put("id",id == null ? "minecraft:air" : id.toString()); out.put("count",stack.getCount());
        if (!stack.isEmpty()) {
            out.put("max_count",stack.getMaxStackSize());
            if (stack.getMaxDamage()>0) { out.put("damage",stack.getDamageValue()); out.put("max_damage",stack.getMaxDamage()); }
            if (includeComponents) {
                var registry = server.registryAccess().lookupOrThrow(Registries.DATA_COMPONENT_TYPE);
                List<String> names = new ArrayList<>();
                for(var type:stack.getComponents().keySet()) { var key=registry.getKey(type); if(key!=null) names.add(key.toString()); }
                names.sort(String::compareTo); out.set("component_names",mapper.valueToTree(names));
            }
        }
        return out;
    }
}
