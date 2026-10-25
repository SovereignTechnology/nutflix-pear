/**
 * Protomux numbers a channel's message types in `addMessage` order and silently drops a type
 * the channel did not add (protomux 3.11.0 `Channel._recv`). NFX-12 §3–§4 make an unknown
 * type a protocol error, so after its pinned types each channel adds a few trap types that
 * close it. Indices past the traps are still dropped unseen: harmless, since a dropped
 * message changes no state, but not the close the spec asks for.
 */
import type { ProtomuxChannel } from 'protomux';

/** Trap types added after a protocol's pinned ones. */
export const TRAPPED_TYPES = 4;

export function addTraps(channel: ProtomuxChannel, onTrap: () => void): void {
  for (let i = 0; i < TRAPPED_TYPES; i++) channel.addMessage({ onmessage: onTrap });
}
