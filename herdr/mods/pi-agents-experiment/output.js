// Reads assistant output on demand from the machine running the parent Pi.
// No shell interpolation, prompts or tool arguments cross this interface.
export const READ_OUTPUT = `
import { openSync, readSync, closeSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const id = process.argv[1];
if (!/^(?:sa|btw)-[0-9a-f]{8}$/.test(id)) throw new Error("Invalid subagent id");
const expandHome = (value) => value === "~" ? homedir() : value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
const root = realpathSync(expandHome(process.env.PI_SUBAGENT_STATE_DIR || path.join(agentDir, "state", "subagents")));
const file = realpathSync(path.join(root, id, "snapshot.json"));
if (path.dirname(file) !== path.join(root, id)) throw new Error("Snapshot is outside the run directory");
const maxBytes = 2 * 1024 * 1024;
const raw = Buffer.alloc(maxBytes + 1);
const fd = openSync(file, "r");
let length = 0;
try {
  while (length < raw.length) {
    const count = readSync(fd, raw, length, raw.length - length, null);
    if (count === 0) break;
    length += count;
  }
} finally {
  closeSync(fd);
}
if (length > maxBytes) throw new Error("Snapshot is too large");
const snapshot = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw.subarray(0, length)));
if (snapshot.id !== id || !["running", "done", "failed", "cancelled"].includes(snapshot.status)) throw new Error("Invalid snapshot");
let text = snapshot.liveAssistant?.text || snapshot.finalText || "";
if (!text.trim()) {
  for (const item of (snapshot.transcript || []).toReversed()) {
    if (item.kind !== "assistant") continue;
    text = (item.parts || []).filter((part) => part.type === "text").map((part) => part.text || "").join("\\n");
    if (text.trim()) break;
  }
}
const characters = [...text];
console.log(JSON.stringify({
  status: snapshot.status,
  text: characters.slice(0, 256 * 1024).join(""),
  truncated: characters.length > 256 * 1024,
  tools: (snapshot.currentTools || []).filter((tool) => typeof tool === "string").slice(0, 8).map((tool) => tool.slice(0, 80)),
}));
`;

export function outputRequest(parent, id) {
  if (!/^(?:sa|btw)-[0-9a-f]{8}$/.test(id)) {
    throw new Error("Invalid subagent id");
  }
  const slash = parent.lastIndexOf("/");
  return {
    command: "node",
    args: ["--input-type=module", "-e", READ_OUTPUT, "--", id],
    options: { on: slash < 0 ? null : parent.slice(0, slash), timeout: 5000 },
  };
}

export function outputStatus(status) {
  return (
    { running: "working", done: "done", failed: "blocked", cancelled: "idle" }[
      status
    ] ?? "idle"
  );
}
