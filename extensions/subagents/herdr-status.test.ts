/**
 * Subagent status for Herdr: the OSC 7501 records written for each run, and
 * the extension lifecycle that writes and clears them. Reports are checked
 * against the protocol's grammar and limits, then applied to a model of
 * herdr-core's record store (a report replaces its record, `clear` removes a
 * record and everything under it) to compare what Herdr would hold.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Layer, ManagedRuntime } from "effect";
import { BackendRegistry } from "./src/backend.ts";
import { makeStubBackend } from "./src/backends/stub.ts";
import type { BackendName } from "./src/domain.ts";
import {
  createHerdrStatus,
  herdrStatusWriter,
  type PublishedSnapshot,
  RECORD_ROOT,
  subagentRecords,
} from "./src/herdr-status.ts";
import { SubagentManagerLive } from "./src/manager.ts";
import subagentsExtension from "./index.ts";

const stateDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "pi-subagents-herdr-test-"),
);
process.env.PI_SUBAGENT_STATE_DIR = stateDirectory;
after(() => fs.rmSync(stateDirectory, { recursive: true, force: true }));

// --- The protocol, as herdr-core applies it -------------------------------

const REPORT = /\x1b\]7501;([^\x07\x1b]*)\x1b\\/g;
const SEGMENT = /^[A-Za-z0-9_.+-]{1,32}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

interface Report {
  state: string;
  id?: string;
  app?: string;
  title?: string;
}

/** Every report in `output`, which must hold nothing else, checked against the spec. */
function reports(output: string): Report[] {
  assert.equal(output.replace(REPORT, ""), "", "only OSC 7501 reports");
  return [...output.matchAll(REPORT)].map(([sequence, body = ""]) => {
    assert.ok(sequence.length <= 4096, "sequence limit");
    const pairs = new Map(
      body.split(":").map((pair) => {
        const eq = pair.indexOf("=");
        return [pair.slice(0, eq), pair.slice(eq + 1)] as const;
      }),
    );
    const id = pairs.get("id");
    if (id !== undefined) {
      const segments = id.split("/");
      assert.ok(id.length <= 128 && segments.length <= 8, `id ${id}`);
      assert.ok(
        segments.every((segment) => SEGMENT.test(segment)),
        `id ${id}`,
      );
    }
    const encoded = pairs.get("title");
    let title: string | undefined;
    if (encoded !== undefined) {
      const bytes = Buffer.from(encoded, "base64");
      assert.ok(encoded.length <= 256 && bytes.length <= 192, "title limit");
      title = bytes.toString("utf8");
      assert.ok(!CONTROL.test(title), "no control characters");
      assert.ok(!title.includes("\ufffd"), "valid UTF-8");
    }
    return {
      state: pairs.get("state") ?? "",
      id,
      app: pairs.get("app"),
      title,
    };
  });
}

type Records = Map<string, Omit<Report, "id">>;

/** Applies reports as core does; the root record is tracked as id "". */
function apply(records: Records, output: string) {
  for (const { id = "", ...record } of reports(output)) {
    if (record.state === "clear") {
      for (const key of [...records.keys()]) {
        if (id === "" || key === id || key.startsWith(`${id}/`)) {
          records.delete(key);
        }
      }
    } else {
      records.set(id, record);
    }
  }
  return records;
}

const snapshot = (
  fields: Partial<PublishedSnapshot> & Pick<PublishedSnapshot, "id">,
): PublishedSnapshot => ({
  origin: "model",
  backend: "pi",
  title: fields.id,
  status: "running",
  collected: false,
  ...fields,
});

// --- Records ----------------------------------------------------------------

test("records follow the footer and carry only names, states and harnesses", () => {
  const records = apply(
    new Map(),
    [
      ...subagentRecords([
        snapshot({ id: "sa-1", title: "review auth", backend: "claude" }),
        snapshot({ id: "sa-2", status: "done", title: "build" }),
        snapshot({ id: "sa-3", status: "failed", backend: "codex" }),
        snapshot({ id: "sa-4", status: "cancelled", title: "slow" }),
        snapshot({ id: "sa-5", status: "done", collected: true }),
        snapshot({
          id: "btw-1",
          origin: "btw",
          title: "what is my API key again",
        }),
      ]).values(),
    ].join(""),
  );
  assert.deepEqual(Object.fromEntries(records), {
    "pi-subagents/sa-1": {
      state: "working",
      app: "claude",
      title: "review auth",
    },
    "pi-subagents/sa-2": { state: "done", app: "pi", title: "build" },
    "pi-subagents/sa-3": { state: "error", app: "codex", title: "sa-3" },
    "pi-subagents/sa-4": { state: "idle", app: "pi", title: "slow" },
    // A by-the-way title is the user's question.
    "pi-subagents/btw-1": { state: "working", app: "pi", title: "by the way" },
  });
});

test("titles stay one line within 192 UTF-8 bytes; unusable ids are skipped", () => {
  const titles = [
    ...subagentRecords([
      snapshot({ id: "a", title: "two\nlines\u001b[31m\u0085here" }),
      snapshot({ id: "b", title: "ü".repeat(150) }),
      snapshot({ id: "c", title: "😀".repeat(60) }),
      snapshot({ id: "d", title: " \t " }),
      snapshot({ id: "bad id" }),
      snapshot({ id: "x".repeat(33) }),
    ]).values(),
  ].map((report) => reports(report)[0]?.title);
  assert.deepEqual(titles, [
    "two lines [31m here",
    "ü".repeat(96),
    "😀".repeat(48),
    "subagent",
  ]);
});

test("updates write only changes and clear only this namespace", () => {
  const writes: string[] = [];
  const status = createHerdrStatus((data) => writes.push(data));
  const records: Records = new Map([["", { state: "working", app: "pi" }]]);
  const run = snapshot({ id: "sa-1", title: "review" });
  const other = snapshot({ id: "sa-2", title: "build" });

  status.update([run, other]);
  status.update([run, other]);
  assert.equal(writes.length, 1, "an unchanged update writes nothing");

  status.update([{ ...run, status: "done" }, other]);
  assert.deepEqual(
    reports(writes[1] ?? "").map((report) => report.id),
    ["pi-subagents/sa-1"],
  );

  status.update([{ ...run, status: "done", collected: true }, other]);
  assert.deepEqual(reports(writes[2] ?? ""), [
    {
      state: "clear",
      id: "pi-subagents/sa-1",
      app: undefined,
      title: undefined,
    },
  ]);

  status.replay();
  for (const data of writes) apply(records, data);
  assert.deepEqual([...records.keys()], ["", "pi-subagents/sa-2"]);

  status.clear();
  apply(records, writes.at(-1) ?? "");
  // Pi's own root status survives.
  assert.deepEqual(Object.fromEntries(records), {
    "": { state: "working", app: "pi" },
  });

  const failing = createHerdrStatus(() => {
    throw new Error("EIO");
  });
  assert.doesNotThrow(() => failing.update([run]));
  assert.doesNotThrow(() => failing.clear());
});

test("the writer is active only on a herdr-core terminal", () => {
  const tty = { isTTY: true, write: () => true };
  assert.equal(herdrStatusWriter({}, tty), undefined);
  assert.equal(
    herdrStatusWriter({ HC_TERMINAL_ID: "t1" }, { ...tty, isTTY: false }),
    undefined,
  );
  assert.equal(
    herdrStatusWriter({ HC_TERMINAL_ID: "t1", PI_PROGRAM_STATUS: "0" }, tty),
    undefined,
  );
  const written: string[] = [];
  herdrStatusWriter(
    { HC_TERMINAL_ID: "t1" },
    { isTTY: true, write: (data: string) => written.push(data) },
  )?.("report");
  assert.deepEqual(written, ["report"]);
});

// --- Extension lifecycle ------------------------------------------------------

const createStubRuntime = () =>
  ManagedRuntime.make(
    SubagentManagerLive.pipe(
      Layer.provide(
        Layer.sync(
          BackendRegistry,
          () =>
            new Map<BackendName, ReturnType<typeof makeStubBackend>>([
              [
                "claude",
                makeStubBackend({
                  backend: "claude",
                  defaultModelLabel: "claude/stub",
                  contextWindow: 200_000,
                  toolName: "Bash",
                  cadenceMs: 5,
                }),
              ],
            ]),
        ),
      ),
    ),
  );

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

/** The extension in a fake Pi host, writing Herdr reports into `output`. */
function host(mode: ExtensionContext["mode"]) {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolDefinition>();
  let output = "";
  let writers = 0;
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    registerMessageRenderer() {},
    registerEntryRenderer() {},
    registerCommand() {},
    registerShortcut() {},
    getThinkingLevel: () => "off",
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: process.cwd(),
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus() {},
      notify() {},
    },
    sessionManager: {
      getSessionId: () => `parent-${Math.random().toString(36).slice(2)}`,
    },
    isIdle: () => true,
    isProjectTrusted: () => true,
  } as unknown as ExtensionToolContext;

  subagentsExtension(pi, createStubRuntime, () => {
    writers++;
    return (data) => {
      output += data;
    };
  });

  const emit = async (event: string) => {
    for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
  };
  const call = async (name: string, params: Record<string, unknown>) => {
    const tool = tools.get(name);
    assert.ok(tool, `missing tool ${name}`);
    const result = await tool.execute(
      "call",
      params,
      new AbortController().signal,
      undefined,
      ctx,
    );
    const [first] = result.content;
    return first?.type === "text" ? first.text : "";
  };
  const spawn = async (name: string, prompt: string) => {
    const text = await call("subagent-spawn-direct", {
      name,
      harness: "claude",
      prompt,
    });
    const id = /subagent (sa-[\w-]+)/.exec(text)?.[1];
    assert.ok(id, text);
    return id;
  };
  return {
    output: () => output,
    writers: () => writers,
    emit,
    call,
    spawn,
  };
}

/** What Herdr holds after `output`, with Pi's root status already there. */
const held = (output: string) =>
  Object.fromEntries(
    apply(new Map([["", { state: "working", app: "pi" }]]), output),
  );

async function until(check: () => boolean, what: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test("the TUI publishes runs until they are collected and clears only its records", async () => {
  const pi = host("tui");
  await pi.emit("session_start");
  // Startup clears what a reload or a crashed Pi may have left.
  assert.deepEqual(reports(pi.output()), [
    { state: "clear", id: RECORD_ROOT, app: undefined, title: undefined },
  ]);

  const done = await pi.spawn("review auth", "SECRET-PROMPT finish normally");
  const failed = await pi.spawn("build", "REJECT:claude fail at startup");
  const doneId = `${RECORD_ROOT}/${done}`;
  const failedId = `${RECORD_ROOT}/${failed}`;
  assert.deepEqual(held(pi.output())[doneId], {
    state: "working",
    app: "claude",
    title: "review auth",
  });

  await until(
    () =>
      held(pi.output())[doneId]?.state === "done" &&
      held(pi.output())[failedId]?.state === "error",
    "both runs to settle",
  );

  // Collecting a result removes its row; the uncollected failure stays.
  await pi.call("subagent-wait", { ids: [done] });
  assert.deepEqual(Object.keys(held(pi.output())), ["", failedId]);

  // A new parent run restores rows the terminal may have dropped.
  const before = pi.output().length;
  await pi.emit("agent_start");
  assert.deepEqual(
    reports(pi.output().slice(before)).map((report) => report.id),
    [failedId],
  );

  await pi.emit("session_shutdown");
  assert.deepEqual(held(pi.output()), { "": { state: "working", app: "pi" } });
  // Startup, the collected run, shutdown; never the root record.
  assert.deepEqual(
    reports(pi.output())
      .filter((report) => report.state === "clear")
      .map((report) => report.id),
    [RECORD_ROOT, doneId, RECORD_ROOT],
  );
  assert.ok(!pi.output().includes("SECRET"), "no prompt text");
});

for (const mode of ["rpc", "print", "json"] as const) {
  test(`only the TUI writes: ${mode} mode stays silent`, async () => {
    const pi = host(mode);
    await pi.emit("session_start");
    const id = await pi.spawn("headless", "finish normally");
    await pi.call("subagent-wait", { ids: [id] });
    await pi.emit("agent_start");
    await pi.emit("session_shutdown");
    assert.equal(pi.writers(), 0);
    assert.equal(pi.output(), "");
  });
}
