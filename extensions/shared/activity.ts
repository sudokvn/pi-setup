import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Background work shown in the footer. The footer belongs to the ui
 * extension, which cannot see another extension's state, so each source
 * publishes its counts on Pi's shared event bus whenever they may have changed.
 */
const ACTIVITY_CHANNEL = "activity:counts";

const SOURCES = ["terminals", "subagents"] as const;
export type ActivitySource = (typeof SOURCES)[number];

export interface ActivityCounts {
  running: number;
  /** Finished, and not collected yet. */
  ready: number;
  failed: number;
  /** Killed or cancelled, and not collected yet. */
  cancelled: number;
}

export const NO_ACTIVITY: ActivityCounts = {
  running: 0,
  ready: 0,
  failed: 0,
  cancelled: 0,
};

interface Countable {
  status: "running" | "done" | "failed" | "killed" | "cancelled";
  collected: boolean;
}

/** Results stop counting once a tool has returned them or the user cleared them. */
export function countActivity(items: readonly Countable[]) {
  const counts = { ...NO_ACTIVITY };
  for (const item of items) {
    if (item.status === "running") counts.running += 1;
    else if (item.collected) continue;
    else if (item.status === "done") counts.ready += 1;
    else if (item.status === "failed") counts.failed += 1;
    else counts.cancelled += 1;
  }
  return counts;
}

type Bus = Pick<ExtensionAPI, "events">;

export function publishActivity(
  pi: Bus,
  source: ActivitySource,
  counts: ActivityCounts,
) {
  pi.events.emit(ACTIVITY_CHANNEL, { source, counts });
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseCounts(value: unknown) {
  if (typeof value !== "object" || value === null) return null;
  if (!("running" in value) || !isCount(value.running)) return null;
  if (!("ready" in value) || !isCount(value.ready)) return null;
  if (!("failed" in value) || !isCount(value.failed)) return null;
  if (!("cancelled" in value) || !isCount(value.cancelled)) return null;
  return {
    running: value.running,
    ready: value.ready,
    failed: value.failed,
    cancelled: value.cancelled,
  } satisfies ActivityCounts;
}

/** Subscribe to count updates. The bus is untyped, so malformed events are ignored. */
export function onActivity(
  pi: Bus,
  listener: (source: ActivitySource, counts: ActivityCounts) => void,
) {
  return pi.events.on(ACTIVITY_CHANNEL, (data) => {
    if (typeof data !== "object" || data === null) return;
    if (!("source" in data) || !("counts" in data)) return;
    const source = SOURCES.find((name) => name === data.source);
    const counts = parseCounts(data.counts);
    if (source && counts) listener(source, counts);
  });
}
