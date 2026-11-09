import assert from "node:assert/strict";
import test from "node:test";
import { childEntries, childStatus } from "./children.js";

test("Pi runs stay under their parent alongside native children", () => {
  const entries = childEntries(
    [
      {
        address: "remote/t1",
        state: "live",
        records: {
          "pi-subagents/sa-1": { title: "Review", state: "done" },
          build: { title: "Unrelated", state: "working" },
        },
      },
      {
        address: "remote/t2",
        parent: "remote/t1",
        state: "live",
        status: "done",
      },
      {
        address: "other/t1",
        state: "live",
        records: {
          "pi-subagents/sa-1": {
            title: "Other parent's run",
            state: "working",
          },
        },
      },
    ],
    "remote/t1",
  );
  assert.equal(entries.length, 2);
  assert.equal(entries[0].t.address, "remote/t2");
  assert.equal(entries[1].parent, "remote/t1");
  assert.equal(entries[1].t, undefined);
  assert.equal(entries[1].record.name, "Review");
  assert.equal(childStatus(entries[0], new Map()), "idle");
  assert.equal(childStatus(entries[1], new Map()), "done");
});
