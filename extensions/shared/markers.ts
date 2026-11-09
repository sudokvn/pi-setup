import type { Theme } from "@earendil-works/pi-coding-agent";

/**
 * One set of status glyphs for everything this package draws as a row or a
 * count: tool rows, subagent and terminal results, pickers, footer widgets.
 * Tool rows animate a spinner while running; static places use the dot.
 */
export type MarkerStatus = "running" | "done" | "failed" | "cancelled";

const GLYPH: Record<MarkerStatus, string> = {
  running: "●",
  done: "✓",
  failed: "✗",
  cancelled: "○",
};

const COLOR: Record<MarkerStatus, "warning" | "success" | "error" | "muted"> = {
  running: "warning",
  done: "success",
  failed: "error",
  cancelled: "muted",
};

export function marker(theme: Theme, status: MarkerStatus) {
  return theme.fg(COLOR[status], GLYPH[status]);
}

/** A count with its marker, for footer widgets: `✓ 2 ready`. */
export function countMarker(theme: Theme, status: MarkerStatus, text: string) {
  return theme.fg(COLOR[status], `${GLYPH[status]} ${text}`);
}
