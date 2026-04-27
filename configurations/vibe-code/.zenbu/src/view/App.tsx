import { useState, useRef, useCallback, useEffect } from "react"

const DEFAULT_URL = "http://localhost:3000"

export function App() {
  const [url, setUrl] = useState(DEFAULT_URL)
  const [inputValue, setInputValue] = useState(DEFAULT_URL)
  const [isDesktop, setIsDesktop] = useState(true)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const historyRef = useRef<string[]>([DEFAULT_URL])
  const historyIndexRef = useRef(0)

  const navigate = useCallback((newUrl: string) => {
    let resolved = newUrl
    if (resolved.startsWith("file://")) {
      resolved = "zenbu-file://" + resolved.slice("file://".length)
    } else if (!/^(https?|zenbu-file):\/\//.test(resolved)) {
      resolved = "http://" + resolved
    }
    const idx = historyIndexRef.current
    historyRef.current = [...historyRef.current.slice(0, idx + 1), resolved]
    historyIndexRef.current = historyRef.current.length - 1
    setUrl(resolved)
    setInputValue(resolved)
    setCanGoBack(historyIndexRef.current > 0)
    setCanGoForward(false)
  }, [])

  const goBack = useCallback(() => {
    if (historyIndexRef.current <= 0) return
    historyIndexRef.current--
    const prev = historyRef.current[historyIndexRef.current]
    setUrl(prev)
    setInputValue(prev)
    setCanGoBack(historyIndexRef.current > 0)
    setCanGoForward(true)
  }, [])

  const goForward = useCallback(() => {
    if (historyIndexRef.current >= historyRef.current.length - 1) return
    historyIndexRef.current++
    const next = historyRef.current[historyIndexRef.current]
    setUrl(next)
    setInputValue(next)
    setCanGoBack(true)
    setCanGoForward(historyIndexRef.current < historyRef.current.length - 1)
  }, [])

  const reload = useCallback(() => {
    const iframe = iframeRef.current
    if (!iframe) return
    iframe.src = url
  }, [url])

  const openExternal = useCallback(() => {
    window.open(url, "_blank")
  }, [url])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault()
        navigate(inputValue)
      }
    },
    [inputValue, navigate],
  )

  useEffect(() => {
    const handleKeyboard = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "r") {
        e.preventDefault()
        reload()
      }
    }
    window.addEventListener("keydown", handleKeyboard)
    return () => window.removeEventListener("keydown", handleKeyboard)
  }, [reload])

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: "#1a1a1a",
        color: "#e0e0e0",
        fontFamily: "system-ui, -apple-system, sans-serif",
        fontSize: 13,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 8px",
          borderBottom: "1px solid #2a2a2a",
          flexShrink: 0,
        }}
      >
        <ChromeButton onClick={goBack} disabled={!canGoBack} title="Back">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </ChromeButton>
        <ChromeButton onClick={goForward} disabled={!canGoForward} title="Forward">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </ChromeButton>

        <ChromeButton
          onClick={() => setIsDesktop((d) => !d)}
          title={isDesktop ? "Switch to mobile" : "Switch to desktop"}
          active={!isDesktop}
        >
          {isDesktop ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="5" y="2" width="14" height="20" rx="2" />
              <line x1="12" y1="18" x2="12" y2="18" />
            </svg>
          )}
        </ChromeButton>

        <input
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={(e) => e.target.select()}
          style={{
            flex: 1,
            background: "#252525",
            border: "1px solid #333",
            borderRadius: 6,
            padding: "4px 10px",
            color: "#ccc",
            fontSize: 12,
            outline: "none",
            minWidth: 0,
          }}
          spellCheck={false}
        />

        <ChromeButton onClick={reload} title="Reload">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </ChromeButton>
        <ChromeButton onClick={openExternal} title="Open in browser">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        </ChromeButton>
      </div>

      <div
        style={{
          flex: 1,
          display: "flex",
          justifyContent: "center",
          padding: 0,
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        <iframe
          ref={iframeRef}
          src={url}
          style={{
            width: isDesktop ? "100%" : 375,
            maxWidth: "100%",
            height: "100%",
            border: "none",
            background: "#fff",
            borderRadius: isDesktop ? 0 : 8,
            transition: "width 0.2s ease",
          }}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
        />
      </div>
    </div>
  )
}

function ChromeButton({
  children,
  onClick,
  disabled,
  title,
  active,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  title: string
  active?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 26,
        height: 26,
        borderRadius: 6,
        border: "none",
        background: active ? "#333" : "transparent",
        color: disabled ? "#555" : "#aaa",
        cursor: disabled ? "default" : "pointer",
        flexShrink: 0,
        padding: 0,
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = "#333"
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = "transparent"
      }}
    >
      {children}
    </button>
  )
}
