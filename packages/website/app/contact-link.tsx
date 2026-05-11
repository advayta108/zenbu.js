"use client";

import { useEffect, useRef, useState } from "react";

const EMAIL = "rob@zenbu.dev";

export function ContactLink({ className }: { className?: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(EMAIL);
    } catch {
    }
    setCopied(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), 1800);
  };

  return (
    <button
      type="button"
      onClick={onClick}
      className={className}
      aria-label={copied ? `Copied ${EMAIL}` : "Copy email address"}
    >
      {copied ? `${EMAIL} · Copied` : "Contact"}
    </button>
  );
}
