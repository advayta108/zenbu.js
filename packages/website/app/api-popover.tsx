"use client";

import { useState, useRef, useEffect, useCallback } from "react";

const APIS = [
  { name: "RPC", desc: "End-to-end type safe calls between renderer and main process" },
  { name: "Storage", desc: "Synced persistence layer with automatic schema migrations" },
  { name: "Services", desc: "Dependency injection system with optimal init order and hot reload" },
  { name: "Events", desc: "Type safe event channels from main process to renderer" },
];

export function ApiPopover() {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [above, setAbove] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const visible = open || closing;

  const close = useCallback(() => {
    setClosing(true);
    setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, 120);
  }, []);

  const openPopover = useCallback(() => {
    // Always open below first, then measure and flip if needed
    setAbove(false);
    setOpen(true);
  }, []);

  useEffect(() => {
    if (!open || closing) return;
    // After mount, check if the popover overflows the viewport
    if (popoverRef.current && ref.current) {
      const popoverRect = popoverRef.current.getBoundingClientRect();
      if (popoverRect.bottom > window.innerHeight - 16) {
        setAbove(true);
      }
    }
  }, [open, closing]);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        close();
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open, close]);

  return (
    <span className="relative inline-block" ref={ref}>
      <button
        type="button"
        onClick={() => (open ? close() : openPopover())}
        className="text-blue-500 hover:text-blue-600 transition-colors cursor-pointer underline decoration-blue-500/30 underline-offset-2"
      >
        {"api's"}
      </button>

      {visible && (
        <div
          ref={popoverRef}
          className={`absolute left-1/2 -translate-x-1/2 w-72 rounded-lg border border-zinc-200 bg-white shadow-lg z-50 ${
            above
              ? "bottom-full mb-2 origin-bottom"
              : "top-full mt-2 origin-top"
          } ${closing ? "animate-popover-out" : "animate-popover-in"}`}
        >
          <div className="p-2 space-y-0.5">
            {APIS.map((api) => (
              <div key={api.name} className="rounded-md px-3 py-2">
                <div className="text-sm font-medium text-zinc-800">
                  {api.name}
                </div>
                <div className="text-xs text-zinc-400 mt-0.5">
                  {api.desc}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </span>
  );
}
