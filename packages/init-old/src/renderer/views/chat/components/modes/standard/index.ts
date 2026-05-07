import type { ChatComponents } from "../../../lib/chat-components"
import { UserMessage } from "./UserMessage"
import { AssistantMessage } from "./AssistantMessage"
import { ThinkingBlock } from "./ThinkingBlock"
import { ToolCall } from "./ToolCall"
import { Plan } from "./Plan"
import { PermissionRequest } from "./PermissionRequest"
import { AskQuestion } from "./AskQuestion"
import { Loading } from "./Loading"
import { Interrupted } from "./Interrupted"
import { AuthEvent } from "./AuthEvent"

export const standardComponents: ChatComponents = {
  UserMessage,
  AssistantMessage,
  ThinkingBlock,
  ToolCall,
  Plan,
  PermissionRequest,
  AskQuestion,
  Loading,
  Interrupted,
  AuthEvent,
  containerClassName: "text-sm gap-3",
}
