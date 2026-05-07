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
