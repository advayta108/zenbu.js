import zod from "zod";
import { createSchema, f, type InferSchemaRoot } from "@zenbu/kyju/schema";

const viewRegistryEntrySchema = zod.object({
  type: zod.string(),
  url: zod.string(),
  port: zod.number(),
  icon: zod.string().optional(),
  meta: zod
    .object({
      kind: zod.string().optional(),
      sidebar: zod.boolean().optional(),
      bottomPanel: zod.boolean().optional(),
      label: zod.string().optional(),
    })
    .optional(),
});

const windowBoundsSchema = zod.object({
  x: zod.number(),
  y: zod.number(),
  width: zod.number(),
  height: zod.number(),
});

const windowPrefsSchema = zod.object({
  lastKnownBounds: windowBoundsSchema.optional(),
});

const schema = createSchema({
  /**
   *
   * this needs to be changed, and we probably
   * should have an api for reading in memory state
   * on the service so we don't need to do these hacks
   *
   * */
  lastKnownViewRegistry: f.array(viewRegistryEntrySchema).default([]),
  windowPrefs: f.record(zod.string(), windowPrefsSchema).default({}),
});

export default schema;
export { schema };

export type ViewRegistryEntry = zod.infer<typeof viewRegistryEntrySchema>;
export type WindowBounds = zod.infer<typeof windowBoundsSchema>;
export type WindowPrefs = zod.infer<typeof windowPrefsSchema>;
export type SchemaRoot = InferSchemaRoot<typeof schema>;
export type CoreSchema = typeof schema.shape;
