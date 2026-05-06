import zod from "#zenbu/kyju/node_modules/zod"
import { createSchema, f } from "#zenbu/kyju/src/v2/db/schema"

const devtoolsViewStateSchema = zod.object({
  viewId: zod.string(),
  sidebarOpen: zod.boolean().default(false),
  activeAgentId: zod.string().nullable().default(null),
})

const devtoolsAgentSchema = zod.object({
  agentId: zod.string(),
  createdAt: zod.number(),
})

export const schema = createSchema({
  panelOpen: f.boolean().nullable().default(null),
  viewState: f.record(zod.string(), devtoolsViewStateSchema).default({}),
  agents: f.array(devtoolsAgentSchema).default([]),
})

export type DevtoolsViewState = zod.infer<typeof devtoolsViewStateSchema>
export type DevtoolsAgent = zod.infer<typeof devtoolsAgentSchema>
