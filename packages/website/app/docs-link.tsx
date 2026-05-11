"use client";

import { track } from "@vercel/analytics";

export function DocsLink() {
  return (
    <a
      href="https://zenbulabs.mintlify.app"
      target="_blank"
      rel="noreferrer"
      onClick={() => track("docs_click")}
      className="font-medium text-zinc-900 hover:text-zinc-600 transition-colors"
    >
      Read the docs ↗
    </a>
  );
}
