import assert from "node:assert/strict";
import test from "node:test";
import { OutputFollower } from "./follow.js";

test("an open preview follows a finished run that restarts", async () => {
  const snapshots = [
    { status: "done", text: "First answer" },
    // The record can say working before Pi saves the restarted snapshot.
    { status: "done", text: "First answer" },
    { status: "running", text: "Second answer" },
    { status: "done", text: "Second answer, finished" },
  ];
  let reads = 0;
  const tasks = [];
  const timers = new Set();
  const cx = {
    spawn: (body) => tasks.push(body(cx)),
    timer: {
      after: (_ms, callback) => {
        const timer = { callback, cancel: () => timers.delete(timer) };
        timers.add(timer);
        return timer;
      },
    },
    notify() {},
  };
  const settle = () => Promise.all(tasks.splice(0));
  const tick = async () => {
    const pending = [...timers];
    timers.clear();
    for (const timer of pending) timer.callback(cx);
    await settle();
  };
  const preview = new OutputFollower(async () => snapshots[reads++], "done");

  preview.refresh(cx);
  await settle();
  preview.observe(cx, "done");
  assert.equal(reads, 1);
  assert.equal(timers.size, 0);

  // The restarted record wakes the preview once. Redraws after that stale
  // done read must wait for the timer instead of reading again.
  preview.observe(cx, "working");
  await settle();
  assert.equal(reads, 2);
  preview.observe(cx, "working");
  await settle();
  assert.equal(reads, 2);
  await tick();
  assert.equal(preview.data.text, "Second answer");

  preview.observe(cx, "done");
  await tick();
  assert.equal(preview.data.text, "Second answer, finished");
  assert.equal(reads, 4);
  assert.equal(timers.size, 0);
});
