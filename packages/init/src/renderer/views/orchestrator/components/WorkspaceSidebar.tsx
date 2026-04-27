import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FolderIcon,
  ImageIcon,
  LayoutGridIcon,
  XIcon,
} from "lucide-react";
import { useDb } from "../../../lib/kyju-react";
import { useKyjuClient, useRpc } from "../../../lib/providers";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";

const RAIL_WIDTH = 48;

type ConfigEntry = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  thumbnailBase64: string | null;
};

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
  const workspaces = useDb((root) => root.plugin.kernel.workspaces) as
    | WorkspaceEntry[]
    | undefined;

  const sorted = useMemo(
    () =>
      [...(workspaces ?? [])].sort(
        (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0),
      ),
    [workspaces],
  );

  const [dialogOpen, setDialogOpen] = useState(false);

  return (
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
      <button
        type="button"
        onClick={() => setDialogOpen(true)}
        title="New workspace"
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
      <NewWorkspaceDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={onSelectWorkspace}
      />
    </div>
  );
}

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

  const [dir, setDir] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [iconFile, setIconFile] = useState<File | null>(null);
  const [iconPreview, setIconPreview] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedConfig, setSelectedConfig] = useState<string | null>(null);
  const [selectedConfigName, setSelectedConfigName] = useState<string | null>(null);
  const [configPickerOpen, setConfigPickerOpen] = useState(false);

  useEffect(() => {
    if (!open) {
      setDir(null);
      setName("");
      setNameTouched(false);
      setIconFile(null);
      setIconPreview(null);
      setCreating(false);
      setError(null);
      setSelectedConfig(null);
      setSelectedConfigName(null);
      setConfigPickerOpen(false);
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

  const pickDirectory = useCallback(async () => {
    try {
      const picked: string | null = await rpc.window.pickDirectory();
      if (!picked) return;
      setDir(picked);
      if (!nameTouched) {
        setName(picked.split("/").pop() || picked);
      }
    } catch (e) {
      console.error("[workspace-sidebar] pickDirectory failed:", e);
    }
  }, [rpc, nameTouched]);

  const onIconChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0] ?? null;
      e.target.value = "";
      if (file) setIconFile(file);
    },
    [],
  );

  const canCreate = !!dir && name.trim().length > 0 && !creating;

  const create = useCallback(async () => {
    if (!dir || name.trim().length === 0) return;
    setCreating(true);
    setError(null);
    try {
      const result = await rpc.workspace.createWorkspace(name.trim(), [dir], selectedConfig ?? undefined);
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
  }, [rpc, client, dir, name, iconFile, selectedConfig, onCreated, onOpenChange]);

  const fallback = (name.trim()[0] ?? "?").toUpperCase();

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!creating) onOpenChange(next);
        }}
      >
        <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New workspace</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Folder
            </label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={pickDirectory}
              disabled={creating}
              className="justify-start gap-2 font-normal"
            >
              <FolderIcon />
              <span className="truncate">
                {dir ? dir : "Choose folder…"}
              </span>
            </Button>
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="new-workspace-name"
              className="text-xs font-medium text-muted-foreground"
            >
              Name
            </label>
            <Input
              id="new-workspace-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
              placeholder="my-project"
              disabled={creating}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Icon
            </label>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={creating}
                className="flex items-center justify-center rounded-lg border border-border bg-muted/40 hover:bg-muted transition-colors overflow-hidden"
                style={{ width: 48, height: 48 }}
                title="Upload icon"
              >
                {iconPreview ? (
                  <img
                    src={iconPreview}
                    alt=""
                    className="object-contain"
                    style={{ width: 36, height: 36, borderRadius: 4 }}
                  />
                ) : (
                  <span className="text-base font-medium text-muted-foreground">
                    {fallback}
                  </span>
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
                    className="text-[11px] text-muted-foreground hover:text-foreground self-start"
                  >
                    Remove
                  </button>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/svg+xml,image/png,image/jpeg,image/gif,image/webp,image/x-icon"
                style={{ display: "none" }}
                onChange={onIconChange}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Configuration
            </label>
            {selectedConfig ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setConfigPickerOpen(true)}
                disabled={creating}
                className="justify-start gap-2 font-normal h-auto py-1.5"
              >
                <span className="truncate flex-1 text-left">
                  {selectedConfigName ?? selectedConfig}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedConfig(null);
                    setSelectedConfigName(null);
                  }}
                  disabled={creating}
                  className="text-muted-foreground hover:text-foreground p-0.5 -mr-1 cursor-pointer"
                >
                  <XIcon size={12} />
                </button>
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setConfigPickerOpen(true)}
                disabled={creating}
                className="justify-start gap-2 font-normal"
              >
                <LayoutGridIcon />
                Browse configurations…
              </Button>
            )}
          </div>

          {error && (
            <p className="text-xs text-destructive whitespace-pre-wrap break-words">
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={creating}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={create}
            disabled={!canCreate}
          >
            {creating ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfigPickerDialog
        open={configPickerOpen}
        onOpenChange={setConfigPickerOpen}
        selectedId={selectedConfig}
        onSelect={(id, name) => {
          setSelectedConfig(id === "blank" ? null : id);
          setSelectedConfigName(id === "blank" ? null : name);
          setConfigPickerOpen(false);
        }}
      />
    </>
  );
}

function ConfigPickerDialog({
  open,
  onOpenChange,
  selectedId,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedId: string | null;
  onSelect: (configId: string, name: string) => void;
}) {
  const rpc = useRpc();
  const [configs, setConfigs] = useState<ConfigEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    rpc.workspace
      .listConfigurations()
      .then((list: ConfigEntry[]) => {
        if (!cancelled) setConfigs(list);
      })
      .catch((err: unknown) => {
        console.error("[config-picker] failed to list configurations:", err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, rpc]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Choose a configuration</DialogTitle>
          <DialogDescription>
            Configurations pre-configure your workspace with views, services,
            and tools for a specific workflow.
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
            Loading configurations…
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 max-h-[60vh] overflow-y-auto">
            {configs.map((config) => {
              const isSelected = config.id === selectedId;
              return (
                <button
                  key={config.id}
                  type="button"
                  onClick={() => onSelect(config.id, config.name)}
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
                      <LayoutGridIcon
                        size={24}
                        className="text-muted-foreground/50"
                      />
                    </div>
                  )}
                  <div className="flex flex-col gap-1 p-2.5">
                    <p className="text-sm font-semibold">{config.name}</p>
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {config.description}
                    </p>
                    {config.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {config.tags.map((tag) => (
                          <span
                            key={tag}
                            className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
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
      ]);
      if (result === "change-icon") {
        fileInputRef.current?.click();
      } else if (result === "rescan-icon") {
        try {
          await rpc.workspace.ensureWorkspaceIcon(workspace.id);
        } catch (err) {
          console.error("[workspace-sidebar] rescan icon failed:", err);
        }
      }
    },
    [rpc, workspace.id],
  );

  return (
    <>
      <button
        type="button"
        onClick={onSelect}
        onContextMenu={onContextMenu}
        title={workspace.name}
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
