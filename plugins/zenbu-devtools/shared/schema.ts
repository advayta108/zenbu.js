import { z } from "zod"

export const schema = z.object({
  panelOpen: z.boolean().nullable().default(null),
})
