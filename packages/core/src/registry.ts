import type { SchemaRoot as CoreSchemaRoot } from "./schema";

export type CoreEvents = {
  advice: {
    reload: { scope: string };
  };
};

export type Events = CoreEvents;

export type CoreDbSections = {
  core: CoreSchemaRoot;
};

export type CorePreloads = {};

export type CoreServiceRouter = {};

/**
 * Module-augmentation point for plugin authors. `zen link` generates
 * `<app>/types/zenbu-register.ts` which declares:
 *
 *   declare module "@zenbujs/core/registry" {
 *     interface ZenbuRegister {
 *       db: DbRoot
 *       rpc: ServiceRouter
 *       events: PluginEvents
 *     }
 *   }
 *
 * Server services (`DbService.client`, `RpcService.emit`) and renderer hooks
 * (`useDb`, `useRpc`, `useEvents`) all read their types from this single
 * registry, so the user's plugin types flow everywhere automatically.
 *
 * Mirrors the pattern TanStack Router uses for `Register`.
 */
export interface ZenbuRegister {}

/**
 * Resolve the DB-root type from `ZenbuRegister["db"]`, falling back to a
 * core-only root when no augmentation has been declared (e.g. a plugin that
 * only emits events / RPC and doesn't define its own DB sections).
 */
export type ResolvedDbRoot = ZenbuRegister extends { db: infer T }
  ? T
  : { plugin: CoreDbSections };

/**
 * Resolve the RPC router type from `ZenbuRegister["rpc"]`, falling back to
 * the core router when no augmentation has been declared.
 */
export type ResolvedServiceRouter = ZenbuRegister extends { rpc: infer T }
  ? T
  : CoreServiceRouter;

/**
 * Resolve the events tree from `ZenbuRegister["events"]`, falling back to
 * `CoreEvents` when no augmentation has been declared.
 */
export type ResolvedEvents = ZenbuRegister extends { events: infer T }
  ? T
  : CoreEvents;
