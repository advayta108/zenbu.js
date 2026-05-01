import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FolderIcon,
  ImageIcon,
  LayoutGridIcon,
  PlusIcon,
} from "lucide-react";
import { useDb } from "../../../lib/kyju-react";
import { useKyjuClient, useRpc } from "../../../lib/providers";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../../components/ui/tooltip";

const RAIL_WIDTH = 48;

type WorkspaceEntry = {
  id: string;
  name: string;
  cwds: string[];
  createdAt: number;
  icon: {
    blobId: string;
    origin: "override" | "scanned";
    sourcePath: string | null;
  } | null;
  viewScope?: string;
  hidden?: boolean;
  mirrorOfWorkspaceId?: string | null;
};

export function WorkspaceSidebar({
  windowId,
  activeWorkspaceId,
  onSelectWorkspace,
}: {
  windowId: string;
  activeWorkspaceId: string | null;
  onSelectWorkspace: (workspaceId: string) => void;
}) {
  const rpc = useRpc();
  const client = useKyjuClient();
  // Pull the raw array via useDb (stable reference until kyju mutates it)
  // and filter via useMemo. Filtering inside the useDb selector returned
  // a fresh array on every snapshot read which made useSyncExternalStore
  // perceive the snapshot as ever-changing — infinite re-render loop.
  // Hidden workspaces are agent-window mirrors and never belong in the
  // primary navigation rail.
  const allWorkspaces = useDb(
    (root) => root.plugin.kernel.workspaces,
  ) 
  

  const sorted = useMemo(
    () =>
      [...(allWorkspaces ?? [])]
        .filter((w) => !w.hidden)
        .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)),
    [allWorkspaces],
  );

  const [dialogOpen, setDialogOpen] = useState(false);

  // Force-close any open tooltip when the cursor enters an iframe (or leaves
  // the window). Radix relies on pointer events on the parent doc; once the
  // cursor enters an iframe, those stop firing and the tooltip would otherwise
  // stay visible until you move back over the trigger.
  useEffect(() => {
    const closeAllTooltips = () => {
      document
        .querySelectorAll<HTMLElement>('[data-slot="tooltip-trigger"]')
        .forEach((el) => {
          el.dispatchEvent(
            new PointerEvent("pointerleave", { bubbles: true, cancelable: true }),
          );
        });
    };
    document.documentElement.addEventListener("mouseleave", closeAllTooltips);
    window.addEventListener("blur", closeAllTooltips);
    return () => {
      document.documentElement.removeEventListener("mouseleave", closeAllTooltips);
      window.removeEventListener("blur", closeAllTooltips);
    };
  }, []);

  return (
    <TooltipProvider delayDuration={800} disableHoverableContent>
      <div
        className="shrink-0 flex flex-col items-center gap-1 py-2 overflow-y-auto"
        style={
          {
            width: RAIL_WIDTH,
            background: "var(--zenbu-chrome)",
            WebkitAppRegion: "no-drag",
          } as any
        }
      >
        {sorted.map((ws) => (
          <WorkspaceRailItem
            key={ws.id}
            workspace={ws}
            isActive={ws.id === activeWorkspaceId}
            onSelect={() => onSelectWorkspace(ws.id)}
            onUploadIcon={async (file) => {
              const data = new Uint8Array(await file.arrayBuffer());
              const blobId = await (client as any).createBlob(data, true);
              await rpc.workspace.setWorkspaceIcon(ws.id, blobId, "override");
            }}
          />
        ))}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setDialogOpen(true)}
              className="flex items-center justify-center mt-1 text-(--zenbu-agent-sidebar-muted) hover:text-(--zenbu-agent-sidebar-foreground) hover:bg-(--zenbu-agent-sidebar-hover)"
              style={{
                width: 36,
                height: 36,
                borderRadius: 8,
                border: "1px dashed var(--zenbu-panel-border)",
                cursor: "pointer",
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={-4}>
            New workspace
          </TooltipContent>
        </Tooltip>
        <NewWorkspaceDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onCreated={onSelectWorkspace}
        />
      </div>
    </TooltipProvider>
  );
}

type ConfigEntry = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  thumbnailBase64: string | null;
};

type WizardStep = "choose-type" | "configuration" | "configure";

function NewWorkspaceDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (workspaceId: string) => void;
}) {
  const rpc = useRpc();
  const client = useKyjuClient() as any;
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<WizardStep>("choose-type");
  const [chosenType, setChosenType] = useState<"create" | "existing">("create");
  const [dir, setDir] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [iconFile, setIconFile] = useState<File | null>(null);
  const [iconPreview, setIconPreview] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedConfig, setSelectedConfig] = useState<string | null>(null);
  const [configs, setConfigs] = useState<ConfigEntry[]>([]);
  const [configsLoading, setConfigsLoading] = useState(false);

  useEffect(() => {
    if (!open) {
      setStep("choose-type");
      setChosenType("create");
      setDir(null);
      setName("");
      setIconFile(null);
      setIconPreview(null);
      setCreating(false);
      setError(null);
      setSelectedConfig(null);
      setConfigs([]);
      setConfigsLoading(false);
    }
  }, [open]);

  useEffect(() => {
    if (!iconFile) {
      setIconPreview(null);
      return;
    }
    const url = URL.createObjectURL(iconFile);
    setIconPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [iconFile]);

  useEffect(() => {
    if (step !== "configuration") return;
    let cancelled = false;
    setConfigsLoading(true);
    rpc.workspace
      .listConfigurations()
      .then((list: ConfigEntry[]) => {
        if (cancelled) return;
        setConfigs(list);
        if (list.length > 0 && !selectedConfig) {
          setSelectedConfig(list[0].id);
        }
      })
      .catch((err: unknown) => {
        console.error("[workspace-sidebar] failed to list configurations:", err);
      })
      .finally(() => {
        if (!cancelled) setConfigsLoading(false);
      });
    return () => { cancelled = true; };
  }, [step, rpc]);

  const handleNext = useCallback(async () => {
    if (step === "configuration") {
      setStep("configure");
    } else if (step === "configure") {
      if (name.trim().length === 0) return;
      try {
        let cwdPath = dir;
        if (!cwdPath) {
          const picked: string | null = await rpc.window.pickDirectory();
          if (!picked) return;
          cwdPath = picked;
        }
        setCreating(true);
        setError(null);
        const result = await rpc.workspace.createWorkspace(name.trim(), [cwdPath], selectedConfig ?? undefined);
        if (iconFile) {
          try {
            const data = new Uint8Array(await iconFile.arrayBuffer());
            const blobId = await client.createBlob(data, true);
            await rpc.workspace.setWorkspaceIcon(result.id, blobId, "override");
          } catch (err) {
            console.error("[workspace-sidebar] icon upload failed:", err);
          }
        }
        onCreated(result.id);
        onOpenChange(false);
      } catch (e) {
        console.error("[workspace-sidebar] create failed:", e);
        setError(e instanceof Error ? e.message : String(e));
        setCreating(false);
      }
    }
  }, [step, chosenType, rpc, client, name, iconFile, selectedConfig, onCreated, onOpenChange]);

  const handlePrevious = useCallback(() => {
    if (step === "configure") {
      if (chosenType === "create") setStep("configuration");
      else setStep("choose-type");
    } else if (step === "configuration") {
      setStep("choose-type");
    }
  }, [step, chosenType]);

  const onIconChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0] ?? null;
      e.target.value = "";
      if (file) setIconFile(file);
    },
    [],
  );

  const fallback = (name.trim()[0] ?? "W").toUpperCase();
  const isLastStep = step === "configure";
  const canProceed = step === "configure"
    ? name.trim().length > 0 && !creating
    : true;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!creating) onOpenChange(next);
      }}
    >
      <DialogContent
        className={step === "configuration" ? "sm:max-w-2xl" : "sm:max-w-md"}
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>
            {step === "choose-type" && "New Workspace"}
            {step === "configuration" && "Choose a configuration:"}
            {step === "configure" && "Configure your workspace:"}
          </DialogTitle>
          {step === "configuration" && (
            <DialogDescription>
              Configurations pre-configure your workspace with views, services,
              and tools for a specific workflow.
            </DialogDescription>
          )}
        </DialogHeader>

        {step === "choose-type" && (
          <div className="flex flex-col gap-2">
            {([
              { type: "create" as const, icon: PlusIcon, label: "Create New Workspace..." },
              { type: "existing" as const, icon: FolderIcon, label: "Open Existing Folder..." },
            ]).map(({ type, icon: Icon, label }) => (
              <button
                key={type}
                type="button"
                onClick={async () => {
                  setChosenType(type);
                  if (type === "create") {
                    setStep("configuration");
                  } else {
                    try {
                      const picked: string | null = await rpc.window.pickDirectory();
                      if (!picked) return;
                      setDir(picked);
                      setName(picked.split("/").pop() || picked);
                      setStep("configure");
                    } catch (e) {
                      console.error("[workspace-sidebar] pickDirectory failed:", e);
                    }
                  }
                }}
                className="flex items-center gap-3 rounded-xl bg-muted px-4 py-3.5 text-left transition-colors cursor-pointer hover:bg-muted/80 border border-border"
              >
                <Icon size={20} className="shrink-0 text-muted-foreground" />
                <span className="text-sm font-medium">{label}</span>
              </button>
            ))}
          </div>
        )}

        {step === "configuration" && (
          configsLoading ? (
            <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
              Loading configurations…
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 max-h-[60vh] overflow-y-auto">
              {configs.map((config) => {
                const isSelected = config.id === selectedConfig;
                return (
                  <button
                    key={config.id}
                    type="button"
                    onClick={() => setSelectedConfig(config.id)}
                    className={`text-left rounded-lg border flex flex-col transition-colors cursor-pointer overflow-hidden ${
                      isSelected
                        ? "border-primary bg-primary/5 ring-1 ring-primary"
                        : "border-border bg-muted/20 hover:bg-muted/40 hover:border-foreground/20"
                    }`}
                  >
                    {config.thumbnailBase64 ? (
                      <img
                        src={config.thumbnailBase64}
                        alt=""
                        className="w-full object-cover"
                        style={{ height: 100 }}
                      />
                    ) : (
                      <div
                        className="w-full flex items-center justify-center bg-muted/30"
                        style={{ height: 100 }}
                      >
                        <LayoutGridIcon size={24} className="text-muted-foreground/50" />
                      </div>
                    )}
                    <div className="flex flex-col gap-1 p-2.5">
                      <p className="text-sm font-semibold">{config.name}</p>
                      <p className="text-xs text-muted-foreground line-clamp-2">
                        {config.description}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          )
        )}

        {step === "configure" && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="ws-name" className="text-xs font-medium text-muted-foreground">
                Workspace Name
              </label>
              <Input
                id="ws-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-workspace"
                disabled={creating}
                autoFocus
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-muted-foreground">Icon</label>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={creating}
                  className="flex items-center justify-center rounded-lg border border-border bg-muted/40 hover:bg-muted transition-colors overflow-hidden cursor-pointer"
                  style={{ width: 48, height: 48 }}
                >
                  {iconPreview ? (
                    <img
                      src={iconPreview}
                      alt=""
                      className="object-contain"
                      style={{ width: 36, height: 36, borderRadius: 4 }}
                    />
                  ) : (
                    <span className="text-base font-medium text-muted-foreground">{fallback}</span>
                  )}
                </button>
                <div className="flex flex-col gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={creating}
                    className="gap-1"
                  >
                    <ImageIcon />
                    {iconFile ? "Replace" : "Upload"}
                  </Button>
                  {iconFile && (
                    <button
                      type="button"
                      onClick={() => setIconFile(null)}
                      disabled={creating}
                      className="text-[11px] text-muted-foreground hover:text-foreground self-start cursor-pointer"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            </div>

            {error && (
              <p className="text-xs text-destructive whitespace-pre-wrap wrap-break-word">{error}</p>
            )}
          </div>
        )}

        {step !== "choose-type" && (
          <div className="flex items-center justify-between pt-2 border-t border-border">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={creating}
            >
              Cancel
            </Button>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handlePrevious}
                disabled={creating}
              >
                Previous
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handleNext}
                disabled={!canProceed}
              >
                {isLastStep ? (creating ? "Creating…" : "Create") : "Next"}
              </Button>
            </div>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/svg+xml,image/png,image/jpeg,image/gif,image/webp,image/x-icon"
          style={{ display: "none" }}
          onChange={onIconChange}
        />
      </DialogContent>
    </Dialog>
  );
}

function WorkspaceRailItem({
  workspace,
  isActive,
  onSelect,
  onUploadIcon,
}: {
  workspace: WorkspaceEntry;
  isActive: boolean;
  onSelect: () => void;
  onUploadIcon: (file: File) => Promise<void>;
}) {
  const rpc = useRpc();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const label = workspace.name || workspace.cwds[0]?.split("/").pop() || "?";
  const fallback = (label[0] ?? "?").toUpperCase();

  const onContextMenu = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      const result = await rpc.window.showContextMenu([
        { id: "change-icon", label: "Change Icon..." },
        { id: "rescan-icon", label: "Re-scan Icon from Project" },
        { id: "open-agent-window", label: "Open Agent Window" },
      ]);
      if (result === "change-icon") {
        fileInputRef.current?.click();
      } else if (result === "rescan-icon") {
        try {
          await rpc.workspace.ensureWorkspaceIcon(workspace.id);
        } catch (err) {
          console.error("[workspace-sidebar] rescan icon failed:", err);
        }
      } else if (result === "open-agent-window") {
        try {
          await rpc.workspace.openAgentWindow(workspace.id);
        } catch (err) {
          console.error("[workspace-sidebar] openAgentWindow failed:", err);
        }
      }
    },
    [rpc, workspace.id],
  );

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onSelect}
            onContextMenu={onContextMenu}
            className="relative flex items-center justify-center"
            style={{
              width: 36,
              height: 36,
              borderRadius: 8,
              background: isActive
                ? "var(--zenbu-agent-sidebar-active)"
                : "transparent",
              boxShadow: isActive ? "0 0 0 1px var(--zenbu-panel-border)" : "none",
              cursor: "pointer",
            }}
          >
            <span
              aria-hidden
              className="absolute"
              style={{
                left: -6,
                top: 6,
                bottom: 6,
                width: 3,
                borderRadius: 2,
                background: isActive
                  ? "var(--zenbu-agent-sidebar-foreground)"
                  : "transparent",
              }}
            />
            <WorkspaceIcon
              blobId={workspace.icon?.blobId}
              fallback={fallback}
              isActive={isActive}
            />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={-4}>
          {label}
        </TooltipContent>
      </Tooltip>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/svg+xml,image/png,image/jpeg,image/gif,image/webp,image/x-icon"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          onUploadIcon(file).catch((err) =>
            console.error("[workspace-sidebar] icon upload failed:", err),
          );
        }}
      />
    </>
  );
}

function WorkspaceIcon({
  blobId,
  fallback,
  isActive,
}: {
  blobId: string | undefined;
  fallback: string;
  isActive: boolean;
}) {
  const client = useKyjuClient() as any;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blobId) {
      setUrl(null);
      return;
    }
    let revoke: string | null = null;
    (async () => {
      try {
        const data: Uint8Array | null = await client.getBlobData(blobId);
        if (!data) return;
        const mime = sniffImageMime(data);
        const blob = new Blob([data as BlobPart], { type: mime });
        revoke = URL.createObjectURL(blob);
        setUrl(revoke);
      } catch {}
    })();
    return () => {
      if (revoke) URL.revokeObjectURL(revoke);
      setUrl(null);
    };
  }, [client, blobId]);

  const size = 22;
  if (url) {
    return (
      <img
        src={url}
        alt=""
        className="object-contain"
        style={{
          width: size,
          height: size,
          borderRadius: 4,
        }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className="flex items-center justify-center text-[12px] font-medium"
      style={{
        width: size,
        height: size,
        borderRadius: 4,
        background: isActive
          ? "var(--zenbu-agent-sidebar-hover)"
          : "color-mix(in srgb, var(--zenbu-agent-sidebar-hover) 70%, transparent)",
        color: "var(--zenbu-agent-sidebar-foreground)",
      }}
    >
      {fallback}
    </span>
  );
}

function sniffImageMime(data: Uint8Array): string {
  // PNG: 89 50 4E 47
  if (
    data.length >= 4 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  )
    return "image/png";
  // JPEG: FF D8 FF
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  )
    return "image/jpeg";
  // GIF: 47 49 46
  if (
    data.length >= 3 &&
    data[0] === 0x47 &&
    data[1] === 0x49 &&
    data[2] === 0x46
  )
    return "image/gif";
  // WebP: RIFF....WEBP
  if (
    data.length >= 12 &&
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  )
    return "image/webp";
  // ICO: 00 00 01 00
  if (
    data.length >= 4 &&
    data[0] === 0x00 &&
    data[1] === 0x00 &&
    data[2] === 0x01 &&
    data[3] === 0x00
  )
    return "image/x-icon";
  return "image/svg+xml";
}
