package dev.dsh.bridge.mixin;

import net.minecraftforge.network.NetworkRegistry;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * Forces Forge to accept vanilla (non-Forge) client connections.
 *
 * <p>Forge 1.20.1 rejects vanilla clients during login when
 * {@link NetworkRegistry#acceptsVanillaClientConnections()} returns
 * {@code false} (in {@code ServerLifecycleHooks}), with the message
 * "This server has mods that require Forge to be installed on the client...".
 * Returning {@code true} from the HEAD of that method removes the gate, so a
 * vanilla-protocol client such as a Mineflayer test bot can complete the
 * normal 1.20.1 login and play.</p>
 *
 * <p>Both {@code @Mixin} and {@code @Inject} use {@code remap = false}:
 * {@code net.minecraftforge.network.NetworkRegistry} is a Forge class in the
 * production (SRG) environment, so its names must not be remapped. No refmap
 * is required for that reason.</p>
 *
 * <p>This only flips the login gate. Modded blocks/items/entities are still
 * unknown to a vanilla client, and mods that implement their own
 * "vanilla client not allowed" check may still refuse the connection. See the
 * README for limitations.</p>
 */
@Mixin(value = NetworkRegistry.class, remap = false)
public class NetworkRegistryMixin {

    @Inject(
            method = "acceptsVanillaClientConnections",
            at = @At("HEAD"),
            cancellable = true,
            remap = false
    )
    private static void dshTestBridge$forceAcceptVanillaClientConnections(
            CallbackInfoReturnable<Boolean> cir) {
        cir.setReturnValue(Boolean.TRUE);
    }
}
