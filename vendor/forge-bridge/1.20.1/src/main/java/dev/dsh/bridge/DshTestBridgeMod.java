package dev.dsh.bridge;

import net.minecraftforge.fml.common.Mod;

/**
 * DSH Test Bridge - a tiny, server-side-only Forge 1.20.1 mod whose sole
 * purpose is to let a vanilla-protocol client (e.g. a Mineflayer test bot)
 * join a modded Forge test server.
 *
 * <p>All the actual work is done by
 * {@code dev.dsh.bridge.mixin.NetworkRegistryMixin}; this class only exists so
 * that FML has a real {@code @Mod} entry point and never reports the jar as a
 * "mod with no mod class".</p>
 *
 * <p><b>Testing only.</b> Never install this on a public/production server:
 * it disables Forge's vanilla-client rejection gate and modded content will not
 * be available to vanilla clients.</p>
 */
@Mod(DshTestBridgeMod.MOD_ID)
public final class DshTestBridgeMod {
    /** Forge mod id, must match META-INF/mods.toml. */
    public static final String MOD_ID = "dsh_test_bridge";

    public DshTestBridgeMod() {
        // Intentionally empty: the bridge is a Mixin-only mod.
    }
}
