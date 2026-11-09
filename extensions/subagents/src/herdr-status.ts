/**
 * Shows subagent names and states in Herdr.
 *
 * Each run becomes an OSC 7501 (Program Status Protocol) child record of the
 * terminal Pi runs in: `pi-subagents/<run id>`, with the harness as `app`
 * and the run's name as `title`. herdr-core stores records by the terminal
 * that wrote them, so a record belongs to the right parent without any
 * addressing, and parallel Pi sessions in other terminals never mix. Child
 * records leave Pi's own root status, turns and Herdr's notes untouched.
 *
 * Only names, states, harnesses and run ids leave the process: no prompts,
 * output or errors. A by-the-way title is the first line of the user's
 * question, so it is published as "by the way".
 *
 * Records follow the footer: running runs and settled ones the parent has not
 * collected. Only changes are written. Session start and shutdown clear this
 * namespace, never the root record. When Pi exits or the shell takes over again, core
 * drops every record of the terminal by itself.
 *
 * Known limit: Pi clears all of the terminal's records whenever it releases
 * the terminal (suspend, external editor, TUI mode switch) and restores only
 * its root status. A record comes back when its own run's name, state or
 * collection changes, or with the next agent run, which replays all of them.
 * Output and tool activity do not count as changes.
 *
 * Spec: https://www.superlogical.com/rex/docs/build/program-status
 */

import type { SubagentSnapshot, SubagentStatus } from "./domain.ts";

/** Every record lives under this id; clearing it removes only ours. */
export const RECORD_ROOT = "pi-subagents";

const STATES = {
  running: "working",
  done: "done",
  failed: "error",
  // The protocol reports an interrupted program as idle.
  cancelled: "idle",
} as const satisfies Record<SubagentStatus, string>;

// Protocol limits: a report that breaks one is discarded whole.
const ID_SEGMENT = /^[A-Za-z0-9_.+-]{1,32}$/;
const MAX_TITLE_BYTES = 192;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g;

export type PublishedSnapshot = Pick<
  SubagentSnapshot,
  "id" | "origin" | "backend" | "title" | "status" | "collected"
>;

const osc = (body: string) => `\x1b]7501;${body}\x1b\\`;

/** One line of safe text within the decoded title limit. */
function titleText(name: string) {
  const text = name.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    bytes += Buffer.byteLength(char, "utf8");
    if (bytes > MAX_TITLE_BYTES) break;
    end += char.length;
  }
  return text.slice(0, end).trimEnd() || "subagent";
}

/** The records to show, by id, each as its full report. */
export function subagentRecords(snapshots: Iterable<PublishedSnapshot>) {
  const records = new Map<string, string>();
  for (const snap of snapshots) {
    if (snap.status !== "running" && snap.collected) continue;
    if (!ID_SEGMENT.test(snap.id)) continue;
    const id = `${RECORD_ROOT}/${snap.id}`;
    const name = snap.origin === "btw" ? "by the way" : snap.title;
    const title = Buffer.from(titleText(name), "utf8").toString("base64");
    records.set(
      id,
      osc(
        `state=${STATES[snap.status]}:id=${id}:app=${snap.backend}:title=${title}`,
      ),
    );
  }
  return records;
}

export interface HerdrStatus {
  /** Writes what changed since the last update. */
  update(snapshots: Iterable<PublishedSnapshot>): void;
  /** Writes every shown record again, after the terminal may have dropped them. */
  replay(): void;
  /** Removes this namespace's records. */
  clear(): void;
}

export function createHerdrStatus(write: (data: string) => void): HerdrStatus {
  let shown = new Map<string, string>();
  const send = (data: string) => {
    if (!data) return;
    try {
      write(data);
    } catch {
      // Status is cosmetic; it must never break subagent tools.
    }
  };
  return {
    update(snapshots) {
      const next = subagentRecords(snapshots);
      let data = "";
      for (const id of shown.keys()) {
        if (!next.has(id)) data += osc(`state=clear:id=${id}`);
      }
      for (const [id, report] of next) {
        if (shown.get(id) !== report) data += report;
      }
      shown = next;
      send(data);
    },
    replay() {
      send([...shown.values()].join(""));
    },
    clear() {
      shown = new Map();
      send(osc(`state=clear:id=${RECORD_ROOT}`));
    },
  };
}

/**
 * Writes to Pi's terminal when it is a herdr-core terminal, or `undefined`
 * outside Herdr. `PI_PROGRAM_STATUS=0` turns it off with Pi's own reports.
 */
export function herdrStatusWriter(
  env: NodeJS.ProcessEnv = process.env,
  out: {
    readonly isTTY?: boolean;
    write(data: string): unknown;
  } = process.stdout,
) {
  if (!env.HC_TERMINAL_ID || env.PI_PROGRAM_STATUS === "0" || !out.isTTY) {
    return undefined;
  }
  return (data: string) => {
    out.write(data);
  };
}
