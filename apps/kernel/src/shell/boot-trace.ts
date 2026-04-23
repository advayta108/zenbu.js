export interface TraceSpan {
  parentKey?: string;
  name: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  error?: string;
  meta?: Record<string, unknown>;
}

export interface TraceMark {
  name: string;
  at: number;
  meta?: Record<string, unknown>;
}

export interface ServiceSpan {
  key: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  error?: string;
  /** Child trace spans with `parentKey === this.key`. */
  children: TraceSpan[];
}

export interface LoaderStats {
  name: string;
  resolveCount: number;
  resolveMs: number;
  loadCount: number;
  loadMs: number;
}

export interface BootTrace {
  bootStartedAt: number;
  readyAt: number;
  totalMs: number;
  /** Service-scoped rows (sorted by start time). */
  serviceSpans: ServiceSpan[];
  /** Root-level spans — no `parentKey`, typically kernel-side phases. */
  rootSpans: TraceSpan[];
  /** Point-in-time milestones. */
  marks: TraceMark[];
  /** Accumulated per-loader stats (resolve/load hook counts + time). */
  loaderStats: LoaderStats[];
}

interface Row {
  label: string;
  indent: number;
  startedAt: number;
  durationMs: number;
  error?: string;
}

export function renderFlameGraph(trace: BootTrace, barWidth = 60): string {
  const {
    bootStartedAt,
    readyAt,
    totalMs,
    serviceSpans,
    rootSpans: allRootSpans,
    marks,
    loaderStats,
  } = trace;
  const scale = totalMs > 0 ? barWidth / totalMs : 0;

  // Spans whose name is namespaced (e.g. `kyju:*`) are noisy — 37 db writes
  // during boot would produce hundreds of sub-span rows. Aggregate them into
  // a summary section per namespace instead of rendering each.
  const aggregateNamespaces = ["kyju:"];
  const aggregatedSpans: Record<
    string,
    { name: string; count: number; totalMs: number; maxMs: number; ops: Record<string, number> }
  > = {};
  const rootSpans: TraceSpan[] = [];
  for (const span of allRootSpans) {
    const ns = aggregateNamespaces.find((p) => span.name.startsWith(p));
    if (ns) {
      const bucket = (aggregatedSpans[span.name] ??= {
        name: span.name,
        count: 0,
        totalMs: 0,
        maxMs: 0,
        ops: {},
      });
      bucket.count++;
      bucket.totalMs += span.durationMs;
      bucket.maxMs = Math.max(bucket.maxMs, span.durationMs);
      const opMeta = (span.meta as any)?.op;
      if (typeof opMeta === "string") {
        bucket.ops[opMeta] = (bucket.ops[opMeta] ?? 0) + 1;
      }
    } else {
      rootSpans.push(span);
    }
  }

  const lines: string[] = [];

  const totalSpanCount =
    serviceSpans.length +
    rootSpans.length +
    marks.length +
    serviceSpans.reduce((n, s) => n + s.children.length, 0);
  lines.push(
    `[boot-trace] Service init timeline — total ${totalMs}ms (${totalSpanCount} spans)`,
  );
  lines.push("");

  // ----- Marks section (point-in-time milestones) -----
  if (marks.length > 0) {
    const sortedMarks = [...marks].sort((a, b) => a.at - b.at);
    const maxMarkLen = sortedMarks.reduce(
      (m, k) => Math.max(m, k.name.length + 6),
      10,
    );
    for (const mk of sortedMarks) {
      const offset = mk.at - bootStartedAt;
      const pos = Math.min(barWidth - 1, Math.max(0, Math.round(offset * scale)));
      const line =
        " ".repeat(pos) + "▲" + " ".repeat(Math.max(0, barWidth - pos - 1));
      const label = `mark: ${mk.name}`.padEnd(maxMarkLen);
      lines.push(`${label}  │${line}│ t+${offset}`);
    }
    lines.push("");
  }

  const rows: Row[] = [];

  for (const span of [...rootSpans].sort((a, b) => a.startedAt - b.startedAt)) {
    rows.push({
      label: `phase: ${span.name}`,
      indent: 0,
      startedAt: span.startedAt,
      durationMs: span.durationMs,
      error: span.error,
    });
  }

  if (rootSpans.length > 0 && serviceSpans.length > 0) {
    rows.push({ label: "", indent: 0, startedAt: -1, durationMs: 0 });
  }

  const sortedServices = [...serviceSpans].sort(
    (a, b) => a.startedAt - b.startedAt,
  );
  for (const svc of sortedServices) {
    rows.push({
      label: svc.key,
      indent: 0,
      startedAt: svc.startedAt,
      durationMs: svc.durationMs,
      error: svc.error,
    });
    for (const child of [...svc.children].sort(
      (a, b) => a.startedAt - b.startedAt,
    )) {
      rows.push({
        label: `↳ ${child.name}`,
        indent: 2,
        startedAt: child.startedAt,
        durationMs: child.durationMs,
        error: child.error,
      });
    }
  }

  const maxLabelLen = rows.reduce(
    (m, r) => (r.startedAt < 0 ? m : Math.max(m, r.indent + r.label.length)),
    10,
  );

  for (const row of rows) {
    if (row.startedAt < 0) {
      lines.push("");
      continue;
    }
    const offset = row.startedAt - bootStartedAt;
    const startCell = Math.max(0, Math.round(offset * scale));
    const widthCell = Math.max(1, Math.round(row.durationMs * scale));
    const clampedStart = Math.min(startCell, barWidth - 1);
    const clampedWidth = Math.min(widthCell, barWidth - clampedStart);
    const rightPad = Math.max(0, barWidth - clampedStart - clampedWidth);
    const bar =
      " ".repeat(clampedStart) +
      "█".repeat(clampedWidth) +
      " ".repeat(rightPad);
    const label =
      " ".repeat(row.indent) + row.label.padEnd(maxLabelLen - row.indent);
    const timing = `${String(row.durationMs).padStart(5)}ms  t+${String(offset).padStart(5)}→${offset + row.durationMs}`;
    const suffix = row.error ? `  ✗ ${row.error}` : "";
    lines.push(`${label}  │${bar}│ ${timing}${suffix}`);
  }

  lines.push("");

  const allForSlowest: { label: string; durationMs: number }[] = [];
  for (const s of serviceSpans)
    allForSlowest.push({ label: s.key, durationMs: s.durationMs });
  for (const r of rootSpans)
    allForSlowest.push({
      label: `phase:${r.name}`,
      durationMs: r.durationMs,
    });
  for (const s of serviceSpans)
    for (const c of s.children)
      allForSlowest.push({
        label: `${s.key}.${c.name}`,
        durationMs: c.durationMs,
      });
  const slowest = allForSlowest
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 8);
  lines.push(
    `Slowest: ${slowest.map((s) => `${s.label} (${s.durationMs}ms)`).join(", ")}`,
  );
  lines.push(
    `Window: boot=${new Date(bootStartedAt).toISOString()}  ready=${new Date(readyAt).toISOString()}`,
  );

  if (loaderStats.length > 0) {
    lines.push("");
    lines.push("Loader overhead:");
    for (const s of loaderStats) {
      const resolveAvg = s.resolveCount
        ? (s.resolveMs / s.resolveCount).toFixed(2)
        : "0.00";
      const loadAvg = s.loadCount
        ? (s.loadMs / s.loadCount).toFixed(2)
        : "0.00";
      lines.push(
        `  ${s.name.padEnd(16)} resolve: ${String(s.resolveMs).padStart(5)}ms across ${String(s.resolveCount).padStart(5)} calls (avg ${resolveAvg}ms)  load: ${String(s.loadMs).padStart(5)}ms across ${String(s.loadCount).padStart(4)} calls (avg ${loadAvg}ms)`,
      );
    }
  }

  const aggNames = Object.keys(aggregatedSpans).sort();
  if (aggNames.length > 0) {
    const maxNameLen = aggNames.reduce((m, n) => Math.max(m, n.length), 20);
    lines.push("");
    lines.push("Kyju breakdown (aggregated; individual spans hidden):");
    for (const name of aggNames) {
      const b = aggregatedSpans[name];
      const avg = b.count ? (b.totalMs / b.count).toFixed(2) : "0.00";
      const opsStr = Object.keys(b.ops).length
        ? ` ops=${Object.entries(b.ops)
            .map(([k, v]) => `${k}:${v}`)
            .join(",")}`
        : "";
      lines.push(
        `  ${b.name.padEnd(maxNameLen)}  total ${String(b.totalMs).padStart(5)}ms across ${String(b.count).padStart(4)} calls (avg ${avg}ms, max ${b.maxMs}ms)${opsStr}`,
      );
    }
  }

  return lines.join("\n");
}
