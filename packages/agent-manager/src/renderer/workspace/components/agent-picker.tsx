import { useEffect, useMemo, useRef, useState } from "react"
import { SearchIcon } from "lucide-react"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "#zenbu/init/src/renderer/components/ui/popover"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "#zenbu/init/src/renderer/components/ui/command"
import { useCollection } from "#zenbu/init/src/renderer/lib/kyju-react"
import type { SchemaRoot } from "#zenbu/init/shared/schema"

type AgentItem = SchemaRoot["agents"][number]

// Trigger button + Command popover for loading an existing agent into a
// new chat tab. Filtering by workspace and by "already-open" is the
// caller's responsibility — the picker just renders what it's given.
export function AgentPicker({
  agents,
  openAgentIds,
  onSelect,
}: {
  agents: AgentItem[]
  openAgentIds: Set<string>
  onSelect: (agentId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  const sortedAgents = useMemo(
    () =>
      [...agents]
        .filter((a) => !openAgentIds.has(a.id))
        .sort(
          (a, b) =>
            (b.lastUserMessageAt ?? 0) - (a.lastUserMessageAt ?? 0),
        ),
    [agents, openAgentIds],
  )

  useEffect(() => {
    if (!open) return
    const closeIfOutside = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (
        target &&
        (triggerRef.current?.contains(target) ||
          contentRef.current?.contains(target))
      ) {
        return
      }
      setOpen(false)
    }
    const closeOnWindowBlur = () => setOpen(false)
    document.addEventListener("pointerdown", closeIfOutside, true)
    window.addEventListener("blur", closeOnWindowBlur)
    return () => {
      document.removeEventListener("pointerdown", closeIfOutside, true)
      window.removeEventListener("blur", closeOnWindowBlur)
    }
  }, [open])

  return (
    <Popover open={open} onOpenChange={setOpen} modal={true}>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          className="inline-flex items-center justify-center rounded text-(--zenbu-agent-sidebar-muted) hover:bg-(--zenbu-agent-sidebar-hover) hover:text-(--zenbu-agent-sidebar-foreground) transition-colors"
          style={{ width: 24, height: 24 }}
          title="Search agents in this workspace"
        >
          <SearchIcon size={13} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        className="w-[280px] p-0 ml-2"
        align="start"
        onInteractOutside={() => setOpen(false)}
      >
        <Command>
          <CommandInput placeholder="Search agents in workspace..." />
          <CommandList>
            <CommandEmpty>No agents found.</CommandEmpty>
            <CommandGroup>
              {sortedAgents.map((agent) => (
                <CommandItem
                  key={agent.id}
                  value={agent.id}
                  onSelect={() => {
                    onSelect(agent.id)
                    setOpen(false)
                  }}
                  className="flex items-center gap-2 text-xs"
                >
                  <span className="truncate flex-1">
                    <AgentLabel agent={agent} />
                  </span>
                  {agent.lastUserMessageAt && (
                    <span className="shrink-0 text-[10px] text-neutral-400">
                      {timeAgo(agent.lastUserMessageAt)}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function AgentLabel({ agent }: { agent: AgentItem }) {
  const { items: events } = useCollection(agent.eventLog)
  const label = useMemo(() => {
    if (agent.title?.kind === "set") return agent.title.value
    let last: string | undefined
    for (const event of events) {
      if (event.data.kind === "user_prompt") last = event.data.text
    }
    return last?.replace(/\s+/g, " ").trim() || "New Chat"
  }, [agent.title, events])
  return <>{label}</>
}

function timeAgo(ts: number | undefined): string {
  if (!ts) return ""
  const seconds = Math.floor((Date.now() - ts) / 1000)
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}
