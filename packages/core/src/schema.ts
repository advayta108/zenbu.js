import zod from "zod";
import {
  createSchema,
  f,
  type InferRoot,
  type InferSchema,
} from "@zenbu/kyju/schema";

const viewRegistryEntrySchema = zod.object({
  scope: zod.string(),
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

export const schema = createSchema({
  lastKnownViewRegistry: f.array(viewRegistryEntrySchema).default([]),
  windowPrefs: f.record(zod.string(), windowPrefsSchema).default({}),
});

export type CoreSchema = InferSchema<typeof schema>;
export type SchemaRoot = InferRoot<CoreSchema>;
export type ViewRegistryEntry = zod.infer<typeof viewRegistryEntrySchema>;
export type WindowBounds = zod.infer<typeof windowBoundsSchema>;
export type WindowPrefs = zod.infer<typeof windowPrefsSchema>;
