import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { outputRequest } from "./output.js";

const ID = "sa-0123abcd";
function fixture(t, snapshot) {
  const root = mkdtempSync(path.join(tmpdir(), "pi-output-preview-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, ID, "snapshot.json");
  mkdirSync(path.dirname(file));
  const write = (value) =>
    writeFileSync(
      file,
      JSON.stringify({ id: ID, status: "running", ...value }),
    );
  write(snapshot);
  const read = () =>
    spawnSync(process.execPath, outputRequest("t1", ID).args, {
      encoding: "utf8",
      env: { ...process.env, PI_SUBAGENT_STATE_DIR: root },
      maxBuffer: 8 * 1024 * 1024,
    });
  return { root, file, write, read };
}

test("reader returns live or finished output without private fields", (t) => {
  const { write, read } = fixture(t, {
    prompt: "SECRET TASK",
    liveAssistant: { text: "Current answer", thinking: "PRIVATE THINKING" },
    finalText: "Old answer",
    currentTools: ["read"],
    transcript: [
      {
        kind: "assistant",
        parts: [{ type: "toolCall", argsPreview: "SECRET ARGUMENT" }],
      },
    ],
  });
  const result = read();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    status: "running",
    text: "Current answer",
    truncated: false,
    tools: ["read"],
  });
  write({ status: "done", finalText: "Finished answer" });
  assert.equal(JSON.parse(read().stdout).text, "Finished answer");
});

test("reader bounds output and refuses paths outside the run", (t) => {
  const { root, file, read } = fixture(t, {
    finalText: "😀".repeat(256 * 1024 + 1),
  });
  const output = JSON.parse(read().stdout);
  assert.equal([...output.text].length, 256 * 1024);
  assert.equal(output.truncated, true);
  writeFileSync(file, "x".repeat(2 * 1024 * 1024 + 1));
  assert.notEqual(read().status, 0);
  assert.throws(() => outputRequest("t1", "../secret"));
  rmSync(file);
  const outside = path.join(root, "private.json");
  writeFileSync(
    outside,
    JSON.stringify({ id: ID, status: "done", finalText: "Private" }),
  );
  symlinkSync(outside, file);
  assert.notEqual(read().status, 0);
});
