"use client";

import { useState, useRef, useEffect, useCallback } from "react";

const MACOS_DOWNLOAD_URL = "/api/download/macos";

function AppleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
    </svg>
  );
}

function WindowsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801" />
    </svg>
  );
}

function LinuxIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12.504 0c-.155 0-.315.008-.48.021-4.226.333-3.105 4.807-3.17 6.298-.076 1.092-.3 1.953-1.05 3.02-.885 1.051-2.127 2.75-2.716 4.521-.278.832-.41 1.684-.287 2.489a.424.424 0 00-.11.135c-.26.268-.45.6-.663.839-.199.199-.485.267-.797.4-.313.136-.658.269-.864.68-.09.189-.136.394-.132.602 0 .199.027.4.055.536.058.399.116.728.04.97-.249.68-.28 1.145-.106 1.484.174.334.535.47.94.601.81.2 1.91.135 2.774.6.926.466 1.866.67 2.616.47.526-.116.97-.464 1.208-.946.587-.003 1.23-.269 2.26-.334.699-.058 1.574.267 2.577.2.025.134.063.198.114.333l.003.003c.391.778 1.113 1.368 1.884 1.43.868.134 1.703-.272 2.191-.574.3-.18.599-.306.9-.36.298-.042.586-.077.893-.39.06-.06.098-.136.141-.209.108.062.226.102.36.1.631-.207.975-.502 1.143-.878.263-.568.17-1.202.128-1.629.114-.159.198-.357.256-.636.066-.369-.028-.782-.14-1.169-.18-.5-.39-1.07-.59-1.18-.21-.135-.42-.197-.636-.197-.19 0-.38.048-.556.138-.328-.418-.81-.643-1.372-.772-.51-.12-1.073-.148-1.59-.15-.066-.21-.15-.389-.256-.531-.156-.21-.346-.354-.525-.46-.253-.155-.508-.254-.705-.328a8.37 8.37 0 01-.575-.287 4.49 4.49 0 01-.25-.135c-.123-.074-.2-.153-.27-.247-.09-.119-.155-.293-.196-.507a3.748 3.748 0 01-.057-.727c0-.12.005-.247.016-.372.069-.766.262-1.463.544-2.134.283-.67.623-1.32.964-2.006.338-.68.651-1.392.851-2.219.103-.512.156-1.048.155-1.6.002-1.747-.461-3.266-1.699-3.82C14.278.095 13.375 0 12.504 0z" />
    </svg>
  );
}

export function DownloadPopover() {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visible = open || closing;

  const close = useCallback(() => {
    setClosing(true);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, 120);
  }, []);

  useEffect(() => {
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
      setOpen(false);
      setClosing(false);
    };
  }, []);

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
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        className="inline-flex items-center gap-2 rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 transition-colors cursor-pointer"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        Download demo
      </button>

      {visible && (
        <div className={`absolute left-0 top-full mt-2 w-44 rounded-lg border border-zinc-200 bg-white shadow-lg origin-top-left z-50 ${closing ? "animate-popover-out" : "animate-popover-in"}`}>
          <div className="p-1">
            <a
              href={MACOS_DOWNLOAD_URL}
              className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100 transition-colors"
            >
              <AppleIcon />
              macOS
              <span className="ml-auto text-[11px] text-zinc-400">arm64</span>
            </a>
            <button
              disabled
              className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-zinc-300 w-full cursor-not-allowed"
            >
              <WindowsIcon />
              Windows
              <span className="ml-auto text-[11px]">Soon</span>
            </button>
            <button
              disabled
              className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-zinc-300 w-full cursor-not-allowed"
            >
              <LinuxIcon />
              Linux
              <span className="ml-auto text-[11px]">Soon</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
