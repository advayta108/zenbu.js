// Convert a kebab-case scope name like "bottom-terminal" into a friendly
// label like "Bottom Terminal" for UI surfaces that don't have a manifest
// label.
export function formatScope(scope: string): string {
  return scope
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
}
