import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import {
  countActivity,
  onActivity,
  publishActivity,
  type ActivityCounts,
} from "./activity.ts";

test("a result counts until it is collected, and a kill is not a success", () => {
  assert.deepEqual(
    countActivity([
      { status: "running", collected: false },
      { status: "done", collected: false },
      { status: "done", collected: true },
      { status: "failed", collected: false },
      { status: "killed", collected: false },
      { status: "cancelled", collected: false },
      { status: "cancelled", collected: true },
    ]),
    { running: 1, ready: 1, failed: 1, cancelled: 2 },
  );
});

test("counts cross the event bus, and anything else on the channel is ignored", () => {
  const pi = { events: createEventBus() };
  const received: [string, ActivityCounts][] = [];
  onActivity(pi, (source, counts) => received.push([source, counts]));

  const counts = { running: 2, ready: 0, failed: 1, cancelled: 0 };
  publishActivity(pi, "subagents", counts);
  pi.events.emit("activity:counts", { source: "subagents", counts: "many" });
  pi.events.emit("activity:counts", { source: "elsewhere", counts });

  assert.deepEqual(received, [["subagents", counts]]);
});
