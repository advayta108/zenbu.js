/**
 * Public RPC surface for plugin authors. The underlying transport (zenrpc) is
 * an internal detail; only the names re-exported here are part of
 * `@zenbujs/core`'s stable contract.
 */

export { connectRpc } from "@zenbu/zenrpc";
export type { EventProxy, RouterProxy } from "@zenbu/zenrpc";
