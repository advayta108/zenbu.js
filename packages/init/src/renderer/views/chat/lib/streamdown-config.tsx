import { code } from "@streamdown/code"
import { CodeBlockCopyButton } from "streamdown"
import type { ComponentProps } from "react"
import { ExternalLinkIcon, CopyIcon } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog"
import { Button } from "../../../components/ui/button"
import { useRpc } from "../../../lib/providers"

function Pre(props: ComponentProps<"pre">) {
  return (
    <div className="group/code relative">
      <pre {...props} />
      <CodeBlockCopyButton className="absolute top-2 right-2 opacity-0 group-hover/code:opacity-100 transition-opacity cursor-pointer rounded-md p-1 text-muted-foreground hover:text-foreground bg-background/80 backdrop-blur-sm border border-border" />
    </div>
  )
}

function LinkSafetyModal({
  url,
  isOpen,
  onClose,
}: {
  url: string
  isOpen: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  const rpc = useRpc()
  const handleOpen = () => {
    rpc.window.openExternal(url)
    onClose()
  }
  const handleCopy = () => {
    void navigator.clipboard.writeText(url)
  }
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ExternalLinkIcon className="size-5" />
            Open external link?
          </DialogTitle>
          <DialogDescription>
            You're about to visit an external website.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md bg-muted px-3 py-2 font-mono text-sm break-all">
          {url}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleCopy}>
            <CopyIcon />
            Copy link
          </Button>
          <Button onClick={handleOpen}>
            <ExternalLinkIcon />
            Open link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export const streamdownProps = {
  plugins: { code },
  controls: {
    code: false,
    table: false,
  },
  components: {
    pre: Pre,
  },
  linkSafety: {
    enabled: true,
    renderModal: (props: {
      url: string
      isOpen: boolean
      onClose: () => void
      onConfirm: () => void
    }) => <LinkSafetyModal {...props} />,
  },
}
