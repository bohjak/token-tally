/**
 * usage-component.ts — Interactive tabbed /usage component.
 *
 * Implements a fullscreen tabbed TUI component via ctx.ui.custom().
 * Six tabs: Summary, Models, Repos, Tools, PRs, Daily.
 *
 * Key bindings:
 *   ←/→ or [/]   switch tabs (wraps at ends)
 *   1-6           jump to tab by number
 *   s             cycle since filter: 24h → 7d → month → all → 24h …
 *   q / Esc       close
 *
 * Design:
 *   - Data is loaded lazily on first visit to each tab (loadTab is sync).
 *   - Cache key = `${tab}:${since ?? "all"}` so cycling since re-fetches.
 *   - Render output is cached per width; call invalidate() on state change.
 *   - Every line is truncated to ≤ width via truncateToWidth (ANSI-safe).
 */

import {
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";

import type { UsageTab, UsageSince } from "./usage.ts";

// ── Public types ──────────────────────────────────────────────────────────────

/** Minimal theme interface — satisfied by pi's real Theme class. */
export type Theme = {
  fg: (color: string, text: string) => string;
  bg: (color: string, text: string) => string;
  bold?: (text: string) => string;
};

export interface UsageTabsOpts {
  /** Sync data loader — called with (tab, since) on first visit. */
  loadTab: (tab: UsageTab, since: UsageSince | undefined) => unknown;
  initialTab?: UsageTab;
  since?: UsageSince;
  theme: Theme;
  onClose: () => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TAB_ORDER: UsageTab[] = [
  "summary", "models", "repos", "tools", "prs", "daily",
];

const SINCE_VALUES: UsageSince[] = ["24h", "7d", "month", "all"];

// ── Component ─────────────────────────────────────────────────────────────────

export class UsageTabsComponent {
  private currentTabIdx: number;
  private since: UsageSince | undefined;
  private readonly theme: Theme;
  private readonly loadTab: (tab: UsageTab, since: UsageSince | undefined) => unknown;
  private readonly onClose: () => void;

  /** data cache: key = "${tab}:${since ?? 'all'}" */
  private readonly dataCache = new Map<string, unknown>();
  private readonly errorCache = new Map<string, string>();

  /** render cache: cleared by invalidate() */
  private cachedLines?: string[];
  private cachedWidth?: number;

  /**
   * PRs tab compact/expanded toggle.
   * Persisted for the component lifetime; defaults to compact on narrow
   * terminals (< 100 cols), expanded otherwise.  Set explicitly by [c] key.
   */
  private prsCompact: boolean | undefined; // undefined = auto (set on first render)

  constructor(opts: UsageTabsOpts) {
    const idx = opts.initialTab ? TAB_ORDER.indexOf(opts.initialTab) : 0;
    this.currentTabIdx = idx >= 0 ? idx : 0;
    this.since = opts.since;
    this.theme = opts.theme;
    this.loadTab = opts.loadTab;
    this.onClose = opts.onClose;
  }

  // ── Component interface ───────────────────────────────────────────────────

  invalidate(): void {
    this.cachedLines = undefined;
    this.cachedWidth = undefined;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.right) || matchesKey(data, Key.rightbracket)) {
      this.currentTabIdx = (this.currentTabIdx + 1) % TAB_ORDER.length;
      this.invalidate();
    } else if (matchesKey(data, Key.left) || matchesKey(data, Key.leftbracket)) {
      this.currentTabIdx =
        (this.currentTabIdx - 1 + TAB_ORDER.length) % TAB_ORDER.length;
      this.invalidate();
    } else if (data >= "1" && data <= "6") {
      const idx = parseInt(data, 10) - 1;
      if (idx >= 0 && idx < TAB_ORDER.length) {
        this.currentTabIdx = idx;
        this.invalidate();
      }
    } else if (data === "s" || data === "S") {
      // Cycle since filter and clear data cache so next render reloads.
      const cur = SINCE_VALUES.indexOf(this.since as UsageSince);
      this.since = SINCE_VALUES[(cur + 1) % SINCE_VALUES.length];
      this.dataCache.clear();
      this.errorCache.clear();
      this.invalidate();
    } else if (data === "c" || data === "C") {
      // Toggle PRs compact/expanded view.
      this.prsCompact = !(this.prsCompact ?? false);
      this.invalidate();
    } else if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
      this.onClose();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    if (width < 40) {
      const msg = truncateToWidth(
        this.theme.fg("warning", "(resize terminal — too narrow)"),
        width,
      );
      this.cachedLines = [msg];
      this.cachedWidth = width;
      return this.cachedLines;
    }

    const t = this.theme;
    const tr = (s: string) => truncateToWidth(s, width);
    const lines: string[] = [];

    // ── Tab bar ──────────────────────────────────────────────────────────
    lines.push(tr(this.renderTabBar(width)));
    lines.push(tr(t.fg("border", "─".repeat(width))));

    // ── Body (lazy-load) ─────────────────────────────────────────────────
    const tab = TAB_ORDER[this.currentTabIdx]!;
    const cacheKey = `${tab}:${this.since ?? "all"}`;

    if (!this.dataCache.has(cacheKey) && !this.errorCache.has(cacheKey)) {
      try {
        this.dataCache.set(cacheKey, this.loadTab(tab, this.since));
      } catch (err) {
        this.errorCache.set(cacheKey, String(err));
      }
    }

    const errMsg = this.errorCache.get(cacheKey);
    if (errMsg !== undefined) {
      lines.push(tr(t.fg("error", `Error: ${errMsg}`)));
    } else {
      for (const line of this.renderBody(tab, this.dataCache.get(cacheKey), width)) {
        lines.push(tr(line));
      }
    }

    // ── Footer ────────────────────────────────────────────────────────────
    const sinceLabel = this.since ?? "all";
    lines.push(tr(t.fg("border", "─".repeat(width))));
    const isPrsTab = tab === "prs";
    const footerBase = `←/→ tabs · 1-6 jump · s since (${sinceLabel}) · q quit`;
    const footerExtra = isPrsTab ? " · c compact/expand" : "";
    lines.push(
      tr(t.fg("dim", footerBase + footerExtra)),
    );

    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private renderTabBar(width: number): string {
    const t = this.theme;
    const parts = TAB_ORDER.map((tab, i) => {
      const label = ` ${tab} `;
      return i === this.currentTabIdx
        ? t.bg("selectedBg", t.fg("text", label))
        : t.fg("muted", label);
    });
    // Join then truncate; visibleWidth handles ANSI codes.
    const joined = parts.join("");
    // Pad to width so background fills the row.
    const vw = visibleWidth(joined);
    const padded = vw < width ? joined + " ".repeat(width - vw) : joined;
    return padded;
  }

  private renderBody(tab: UsageTab, data: unknown, width: number): string[] {
    try {
      switch (tab) {
        case "summary": return this.renderSummary(data, width);
        case "models":  return this.renderModels(data, width);
        case "repos":   return this.renderRepos(data, width);
        case "tools":   return this.renderTools(data, width);
        case "prs":     return this.renderPrs(data, width);
        case "daily":   return this.renderDaily(data, width);
      }
    } catch (err) {
      return [this.theme.fg("error", `Render error: ${String(err)}`)];
    }
  }

  // Formatting helpers ────────────────────────────────────────────────────

  private col(val: unknown, w: number, align: "l" | "r" = "l"): string {
    const s = String(val ?? "—");
    return align === "r" ? s.padStart(w).slice(-w) : s.padEnd(w).slice(0, w);
  }
  private fmtUsd(n: number): string { return `$${(n ?? 0).toFixed(4)}`; }
  private fmtNum(n: number): string { return (n ?? 0).toLocaleString("en"); }
  private fmtPct(n: number): string { return `${((n ?? 0) * 100).toFixed(1)}%`; }

  /**
   * Compact integer with k/M suffix.  At column widths typical for a TUI a
   * full "1,800,000" eats too much horizontal space for the signal it
   * carries; "1.8M" is much more scannable.  One decimal place when the
   * suffix would lose precision (e.g. 1.8M not 2M), no decimal when whole.
   *
   *   0       → "0"
   *   1234    → "1.2k"
   *   12_345  → "12k"
   *   1_800_000 → "1.8M"
   *   2_000_000 → "2M"
   *   1_200_000_000 → "1.2B"
   */
  private fmtCount(n: number): string {
    const v = n ?? 0;
    if (!Number.isFinite(v)) return "—";
    const abs = Math.abs(v);
    const sign = v < 0 ? "-" : "";
    if (abs < 1_000) return `${sign}${Math.round(abs)}`;
    const fmt = (x: number, divisor: number, suffix: string) => {
      const scaled = x / divisor;
      // Drop the decimal when the result is whole (e.g. "2M" not "2.0M").
      const s = scaled >= 100 || Math.round(scaled * 10) % 10 === 0
        ? Math.round(scaled).toString()
        : scaled.toFixed(1);
      return `${sign}${s}${suffix}`;
    };
    if (abs < 1_000_000)         return fmt(abs, 1_000,         "k");
    if (abs < 1_000_000_000)     return fmt(abs, 1_000_000,     "M");
    return                              fmt(abs, 1_000_000_000, "B");
  }

  /**
   * Compact duration with auto-scaled units.
   *
   *   0–999       ms → "Nms"        (e.g. "42ms")
   *   1–119      sec → "X.Xs"       (e.g. "1.4s", "42s")
   *   2–59      min → "Mmin Ss"    (e.g. "3min 12s")
   *   60+       min → "Hh Mmin"     (e.g. "1h 4min")
   *
   * The compound forms (e.g. "3min 12s") preserve enough precision for
   * percentile readouts while still scanning easily.
   */
  private fmtDuration(ms: number): string {
    const v = ms ?? 0;
    if (!Number.isFinite(v)) return "—";
    const abs = Math.abs(v);
    const sign = v < 0 ? "-" : "";
    if (abs < 1_000) return `${sign}${Math.round(abs)}ms`;
    const sec = abs / 1_000;
    if (sec < 120) {
      const s = sec >= 10 ? Math.round(sec).toString() : sec.toFixed(1);
      return `${sign}${s}s`;
    }
    const totalMin = Math.floor(abs / 60_000);
    const remSec = Math.round((abs % 60_000) / 1_000);
    if (totalMin < 60) {
      return remSec === 0
        ? `${sign}${totalMin}min`
        : `${sign}${totalMin}min ${remSec}s`;
    }
    const hours = Math.floor(totalMin / 60);
    const remMin = totalMin % 60;
    return remMin === 0
      ? `${sign}${hours}h`
      : `${sign}${hours}h ${remMin}min`;
  }

  /**
   * Render a table that fills the available width.
   *
   * Each column has a `min` (its natural minimum width).  Columns flagged
   * `flex: true` absorb leftover space proportionally; if multiple columns
   * flex, leftover space is split evenly.  Columns without `flex` keep their
   * `min` width.  When the terminal is narrower than the sum of mins, every
   * column is clipped proportionally so the row still fits.
   */
  private renderTable<R>(
    width: number,
    cols: ReadonlyArray<{
      title: string;
      align?: "l" | "r";
      min: number;
      flex?: boolean;
      cell: (row: R) => string;
      headerStyle?: (s: string) => string;
      cellStyle?: (s: string, row: R) => string;
    }>,
    rows: ReadonlyArray<R>,
    emptyMessage = "  No data for this period.",
  ): string[] {
    const t = this.theme;
    const gapCount = Math.max(0, cols.length - 1);
    const totalMin = cols.reduce((s, c) => s + c.min, 0) + gapCount;

    // Allocate widths.  If terminal can fit mins, distribute extra to flex
    // columns; otherwise scale all columns down proportionally.
    let widths: number[];
    if (width >= totalMin) {
      const flexIdxs = cols.map((c, i) => (c.flex ? i : -1)).filter((i) => i >= 0);
      const extra = width - totalMin;
      widths = cols.map((c) => c.min);
      if (flexIdxs.length > 0 && extra > 0) {
        const per = Math.floor(extra / flexIdxs.length);
        let remainder = extra - per * flexIdxs.length;
        for (const i of flexIdxs) {
          widths[i] += per + (remainder-- > 0 ? 1 : 0);
        }
      } else if (flexIdxs.length === 0 && extra > 0) {
        // No flex columns but space available: pad rightmost left-aligned
        // text column so the divider/background extends fully.
        for (let i = cols.length - 1; i >= 0; i--) {
          if ((cols[i].align ?? "l") === "l") { widths[i] += extra; break; }
        }
      }
    } else {
      // Narrow terminal: scale all proportionally, floor each at 1.
      const scale = (width - gapCount) / (totalMin - gapCount);
      widths = cols.map((c) => Math.max(1, Math.floor(c.min * scale)));
    }

    const header = cols.map((c, i) => {
      const cell = this.col(c.title, widths[i], c.align ?? "l");
      return c.headerStyle ? c.headerStyle(cell) : t.fg("accent", cell);
    }).join(" ");
    const divider = t.fg("dim", "─".repeat(width));

    const lines: string[] = [header, divider];
    if (rows.length === 0) {
      lines.push(t.fg("muted", emptyMessage));
      return lines;
    }
    for (const row of rows) {
      lines.push(
        cols.map((c, i) => {
          const raw = c.cell(row);
          const padded = this.col(raw, widths[i], c.align ?? "l");
          return c.cellStyle ? c.cellStyle(padded, row) : padded;
        }).join(" "),
      );
    }
    return lines;
  }

  // Tab renderers ────────────────────────────────────────────────────────────

  private renderSummary(data: unknown, width: number): string[] {
    type Bucket = {
      cost_usd?: number;
      /** Total in+out+cached.  Kept for JSON consumers; not displayed. */
      tokens?: number;
      cached_tokens?: number;
      cached_cost_usd?: number;
      cache_savings_usd?: number;
      turns?: number;
    };
    type D = {
      today:   Bucket;
      week:    Bucket;
      month:   Bucket;
      session: Bucket;
      top_model: { id: string; cost_usd: number; turns: number } | null;
    };
    const d = (data ?? {}) as D;
    const t = this.theme;
    type BucketRow = { label: string; b: Bucket };
    const bucketRows: BucketRow[] = [
      { label: "Today",   b: d.today   ?? {} },
      { label: "Week",    b: d.week    ?? {} },
      { label: "Month",   b: d.month   ?? {} },
      { label: "Session", b: d.session ?? {} },
    ];
    // Token columns:
    //   Fresh   = tokens that actually went over the wire as fresh input or
    //             output (input_tokens + output_tokens), i.e. what you pay
    //             full price for.
    //   Cached  = cache_read + cache_write tokens.
    //   Cache%  = cached / (fresh + cached) — the share of consumed
    //             context served from / written to cache.  This is the
    //             headline efficiency metric; total context size is
    //             implied (fresh + cached) and not worth its own column.
    const rows = this.renderTable<BucketRow>(width, [
      { title: "Bucket",    align: "l", min: 10, flex: true, cell: (r) => r.label },
      { title: "Cost (USD)", align: "r", min: 12, cell: (r) => this.fmtUsd(r.b.cost_usd ?? 0) },
      {
        title: "Fresh", align: "r", min: 8,
        cell: (r) => this.fmtCount(
          Math.max(0, (r.b.tokens ?? 0) - (r.b.cached_tokens ?? 0)),
        ),
      },
      { title: "Cached",    align: "r", min: 8, cell: (r) => this.fmtCount(r.b.cached_tokens ?? 0) },
      {
        title: "Cache%", align: "r", min: 7,
        cell: (r) => {
          const tokens = r.b.tokens ?? 0;
          const cached = r.b.cached_tokens ?? 0;
          return tokens > 0 ? this.fmtPct(cached / tokens) : "—";
        },
      },
      { title: "Turns",     align: "r", min: 7,  cell: (r) => String(r.b.turns ?? 0) },
    ], bucketRows, "  No data.");
    // Cache savings footer — show only when at least one bucket has savings > 0.
    // Display the positive-floored amount (raw value can be slightly negative on
    // cache-write-heavy messages; we hide those rather than confuse the user).
    const savingsParts: string[] = [];
    for (const { label, b } of bucketRows) {
      const saved = b.cache_savings_usd ?? 0;
      if (saved > 0) {
        savingsParts.push(
          t.fg("muted", label.toLowerCase() + " ") +
          t.fg("success", this.fmtUsd(saved)),
        );
      }
    }
    if (savingsParts.length > 0) {
      rows.push("");
      rows.push(
        t.fg("muted", "Cache saved: ") + savingsParts.join(t.fg("muted", " · ")),
      );
    }

    if (d.top_model) {
      rows.push("");
      rows.push(
        t.fg("muted", "Top model: ") +
        t.fg("accent", d.top_model.id) +
        t.fg("muted", ` (${this.fmtUsd(d.top_model.cost_usd)}, ${d.top_model.turns} turns)`),
      );
    }
    return rows;
  }

  private renderModels(data: unknown, width: number): string[] {
    type Row = {
      model_id: string;
      cost_usd: number;
      tokens_in: number;
      tokens_out: number;
      cached_tokens: number;
      cache_hit_rate: number;
      turns: number;
      share: number;
      avg_tokens_per_turn: number;
    };
    const { rows = [] } = (data ?? {}) as { rows?: Row[] };
    return this.renderTable<Row>(width, [
      { title: "Model",        align: "l", min: 24, flex: true, cell: (r) => r.model_id },
      { title: "Cost",         align: "r", min: 10, cell: (r) => this.fmtUsd(r.cost_usd) },
      { title: "Share",        align: "r", min: 7,  cell: (r) => this.fmtPct(r.share) },
      { title: "Turns",        align: "r", min: 6,  cell: (r) => String(r.turns) },
      { title: "Tok in",       align: "r", min: 8,  cell: (r) => this.fmtCount(r.tokens_in) },
      { title: "Tok out",      align: "r", min: 8,  cell: (r) => this.fmtCount(r.tokens_out) },
      { title: "Cached",       align: "r", min: 8,  cell: (r) => this.fmtCount(r.cached_tokens ?? 0) },
      { title: "Cache%",       align: "r", min: 7,  cell: (r) => this.fmtPct(r.cache_hit_rate ?? 0) },
      { title: "Avg/turn",     align: "r", min: 9,  cell: (r) => this.fmtCount(Math.round(r.avg_tokens_per_turn)) },
    ], rows, "  No model data for this period.");
  }

  private renderRepos(data: unknown, width: number): string[] {
    type Row = { repo_remote: string; sessions: number; files_touched: number; cost_usd: number; top_tool: string | null };
    const { rows = [] } = (data ?? {}) as { rows?: Row[] };
    return this.renderTable<Row>(width, [
      { title: "Repo",     align: "l", min: 24, flex: true, cell: (r) => r.repo_remote },
      { title: "Cost",     align: "r", min: 10, cell: (r) => this.fmtUsd(r.cost_usd) },
      { title: "Sessions", align: "r", min: 9,  cell: (r) => String(r.sessions) },
      { title: "Files",    align: "r", min: 6,  cell: (r) => String(r.files_touched) },
      { title: "Top tool", align: "l", min: 12, cell: (r) => r.top_tool ?? "—" },
    ], rows, "  No repo data for this period.");
  }

  private renderTools(data: unknown, width: number): string[] {
    type Row = { name: string; calls: number; total_duration_ms: number; error_rate: number; p50_ms: number; p95_ms: number };
    const { rows = [] } = (data ?? {}) as { rows?: Row[] };
    const t = this.theme;
    return this.renderTable<Row>(width, [
      { title: "Tool",     align: "l", min: 18, flex: true, cell: (r) => r.name },
      { title: "Calls",    align: "r", min: 7,  cell: (r) => this.fmtCount(r.calls) },
      { title: "p50",      align: "r", min: 8,  cell: (r) => this.fmtDuration(r.p50_ms) },
      { title: "p95",      align: "r", min: 8,  cell: (r) => this.fmtDuration(r.p95_ms) },
      {
        title: "ErrRate", align: "r", min: 8,
        cell: (r) => this.fmtPct(r.error_rate),
        cellStyle: (s, r) => (r.error_rate > 0 ? t.fg("error", s) : s),
      },
      { title: "Total",    align: "r", min: 10, cell: (r) => this.fmtDuration(r.total_duration_ms) },
    ], rows, "  No tool data for this period.");
  }

  private renderPrs(data: unknown, width: number): string[] {
    type BreakdownEntry = {
      session_id: string;
      started_at: number;
      phase: "planning" | "implementation" | "fixup";
      cost_usd: number;
      tokens: number;
      turns: number;
      commits: number;
      confidence: number;
      reason: string;
    };
    type PrRow = {
      pr_number: number;
      pr_url: string;
      /** Raw remote URL from pr_associations (added with the repo column). */
      repo_remote?: string;
      /** Short "owner/repo" form derived from repo_remote. */
      repo_short?: string;
      sessions: number;
      total_cost_usd: number;
      total_files: number;
      total_turns: number;
      total_commits: number;
      top_reason: string;
      confidence: number;
      phase_breakdown: { planning: number; implementation: number; fixup: number };
      breakdown: BreakdownEntry[];
    };
    const { rows = [] } = (data ?? {}) as { rows?: PrRow[] };
    const t = this.theme;

    if (rows.length === 0) {
      return [
        t.fg("dim", "─".repeat(width)),
        t.fg("muted", "  No PR associations for this period."),
      ];
    }

    // Auto-detect compact mode from width on first render of this tab.
    if (this.prsCompact === undefined) {
      this.prsCompact = width < 100;
    }
    const compact = this.prsCompact;

    // Phase color helper.
    const phaseColor = (phase: string, text: string): string => {
      if (phase === "implementation") return t.fg("success", text);
      if (phase === "fixup")          return t.fg("warning", text);
      return t.fg("accent", text);   // planning
    };

    /**
     * Phase bar — proportional Unicode blocks for planning/impl/fixup costs.
     * Uses full-block chars scaled to available width (min 10, max 30 cells).
     * planning=accent, implementation=success, fixup=warning.
     */
    const phaseBar = (pb: { planning: number; implementation: number; fixup: number }, barWidth: number): string => {
      const total = pb.planning + pb.implementation + pb.fixup;
      if (total <= 0) return "";
      const W = Math.max(6, Math.min(barWidth, 30));
      const BLOCK = "█";
      const segments: Array<{ phase: string; count: number }> = [
        { phase: "planning",       count: Math.round((pb.planning       / total) * W) },
        { phase: "implementation", count: Math.round((pb.implementation / total) * W) },
        { phase: "fixup",          count: Math.round((pb.fixup          / total) * W) },
      ];
      // Adjust rounding errors so sum = W.
      const rsum = segments.reduce((s, x) => s + x.count, 0);
      if (rsum !== W) segments[1].count += W - rsum;
      return segments.map((s) => phaseColor(s.phase, BLOCK.repeat(Math.max(0, s.count)))).join("");
    };

    const lines: string[] = [t.fg("border", "─".repeat(width))];
    let grandTotal = 0;

    for (const pr of rows) {
      grandTotal += pr.total_cost_usd;
      const pb = pr.phase_breakdown ?? { planning: 0, implementation: 0, fixup: 0 };
      const total = pb.planning + pb.implementation + pb.fixup;

      // Build phase % labels (plain text, no color — these sit after the bar
      // and may be truncated; keeping them plain avoids partial ANSI sequences).
      const pct = (v: number) => total > 0 ? `${Math.round((v / total) * 100)}%` : "";
      const phaseParts: string[] = [];
      if (total > 0) {
        if (pb.planning > 0)       phaseParts.push(`plan ${pct(pb.planning)}`);
        if (pb.implementation > 0) phaseParts.push(`impl ${pct(pb.implementation)}`);
        if (pb.fixup > 0)          phaseParts.push(`fix ${pct(pb.fixup)}`);
      }
      const phaseText = phaseParts.join(" "); // plain text — no ANSI

      // Header line components (all plain text for safe truncation):
      // "make/monorepo#1234 · $9.40 · 3 sess · 27 files · 6 commits"
      // Repo prefix collapses to just "#1234" when the repo is unknown
      // (older rows from before pa.repo_remote was selected, or rows from
      // sessions that never resolved a remote URL).
      const repoPart = (pr.repo_short ?? "").trim();
      const prRef = repoPart ? `${repoPart}#${pr.pr_number}` : `#${pr.pr_number}`;
      const headerPrefix = `${prRef} · ${this.fmtUsd(pr.total_cost_usd)} · ${this.fmtCount(pr.sessions)} sess · ${this.fmtCount(pr.total_files)} files · ${this.fmtCount(pr.total_commits ?? 0)} commits`;

      // Fit the bar in the remaining space, capped at 20 chars.
      const overhead = visibleWidth(headerPrefix) + (phaseText ? visibleWidth(phaseText) + 4 : 0);
      const barWidth = Math.min(20, Math.max(0, width - overhead - 2));
      const bar = phaseBar(pb, barWidth);

      // Assemble header safely:
      //   1. Plain prefix (will be wrapped in accent color).
      //   2. Bar (has ANSI color codes per block char).
      //   3. Phase % text (plain).
      //
      // To avoid truncateToWidth cutting through a mid-bar ANSI escape,
      // only add bar + phaseText if they fit within the remaining width.
      const prefixVisWidth = visibleWidth(headerPrefix);
      const remaining = width - prefixVisWidth;
      let suffix = "";
      if (bar && remaining >= visibleWidth(bar) + 4) {
        // Enough room for "  [bar]  phaseText" — append all, let it be truncated at
        // a safe boundary (after bar's reset code, before phaseText).
        const phaseAppend = phaseText && (remaining >= visibleWidth(bar) + 4 + visibleWidth(phaseText))
          ? `  ${phaseText}`
          : "";
        suffix = `  ${bar}${phaseAppend}`;
      } else if (phaseText && remaining >= visibleWidth(phaseText) + 2) {
        suffix = `  ${phaseText}`;
      }
      const headerLine = t.fg("accent", headerPrefix) + suffix;
      lines.push(truncateToWidth(headerLine, width));

      if (!compact && pr.breakdown && pr.breakdown.length > 0) {
        // Indent detail rows: "  ├ session_id(short) · phase · $cost · N turns · N commits · reason"
        const lastIdx = pr.breakdown.length - 1;
        for (let i = 0; i < pr.breakdown.length; i++) {
          const b = pr.breakdown[i]!;
          const prefix = i === lastIdx ? "  └ " : "  ├ ";
          const sid = b.session_id.slice(0, 8);
          const datePart = new Date(b.started_at).toISOString().slice(0, 10);
          const detail = [
            phaseColor(b.phase, b.phase.slice(0, 4)),
            `${datePart}`,
            this.fmtUsd(b.cost_usd),
            `${this.fmtCount(b.turns)}t`,
            `${this.fmtCount(b.commits)}c`,
            t.fg("dim", b.reason),
            t.fg("dim", sid),
          ].join(" · ");
          lines.push(truncateToWidth(prefix + detail, width));
        }
      }
      // Separator between PRs.
      lines.push(t.fg("dim", "  " + "·".repeat(Math.max(0, width - 2))));
    }

    // Footer: total PR count + grand total cost.
    lines.push(t.fg("muted", `  ${rows.length} PR${rows.length === 1 ? "" : "s"} · total ${this.fmtUsd(grandTotal)} · ${compact ? "[c] expand" : "[c] compact"}`));
    return lines;
  }

  private renderDaily(data: unknown, width: number): string[] {
    type Row = {
      date: string;
      cost_usd: number;
      tokens: number;
      cached_tokens: number;
      cached_cost_usd: number;
      turns: number;
    };
    const { rows = [] } = (data ?? {}) as { rows?: Row[] };
    const t = this.theme;
    const lines: string[] = [];

    // Sparkline (last 30 days, oldest→newest left→right) — stretches to width
    if (rows.length > 0) {
      const label = "Sparkline (last 30d): ";
      const sparkWidth = Math.max(0, width - label.length);
      const recent = rows.slice(0, Math.min(rows.length, sparkWidth || 30)).reverse();
      const maxCost = Math.max(...recent.map((r) => r.cost_usd), 0.0001);
      const BLOCKS = " ▁▂▃▄▅▆▇█";
      const spark = recent
        .map((r) => BLOCKS[Math.min(8, Math.floor((r.cost_usd / maxCost) * 8))])
        .join("");
      lines.push(t.fg("accent", label) + t.fg("text", spark));
      lines.push("");
    }

    lines.push(...this.renderTable<Row>(width, [
      { title: "Date",   align: "l", min: 12, flex: true, cell: (r) => r.date },
      { title: "Cost",   align: "r", min: 12, cell: (r) => this.fmtUsd(r.cost_usd) },
      {
        title: "Fresh",  align: "r", min: 8,
        cell: (r) => this.fmtCount(Math.max(0, r.tokens - (r.cached_tokens ?? 0))),
      },
      { title: "Cached", align: "r", min: 8, cell: (r) => this.fmtCount(r.cached_tokens ?? 0) },
      {
        title: "Cache%", align: "r", min: 7,
        cell: (r) => (r.tokens > 0 ? this.fmtPct((r.cached_tokens ?? 0) / r.tokens) : "—"),
      },
      { title: "Turns",  align: "r", min: 8,  cell: (r) => this.fmtCount(r.turns) },
    ], rows, "  No daily data for this period."));

    return lines;
  }
}
