import type { AuthEventProps } from "../../../lib/chat-components"

export function AuthEvent({ authMethods }: AuthEventProps) {
  return (
    <div className="flex items-center gap-3 py-2 px-3">
      <div className="h-px flex-1 bg-neutral-300" />
      <span className="text-xs text-neutral-400 select-none">
        {authMethods.length > 0
          ? authMethods.map((m) => m.description || m.name).join(" · ")
          : "Authentication required"}
      </span>
      <div className="h-px flex-1 bg-neutral-300" />
    </div>
  )
}
