/**
 * Background results are pull-only: settling never writes into the parent
 * conversation or starts a turn. The footer counts uncollected results until
 * a subagent tool collects them or the user clears them in /subagents, and
 * that state survives reloads. Runs the real extension wiring against stub
 * backends.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Layer, ManagedRuntime } from "effect";
import { BackendRegistry } from "./src/backend.ts";
import { makeStubBackend } from "./src/backends/stub.ts";
import type { BackendName } from "./src/domain.ts";
import { SubagentManagerLive } from "./src/manager.ts";
import subagentsExtension from "./index.ts";

const stateDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "pi-subagents-collection-test-"),
);
process.env.PI_SUBAGENT_STATE_DIR = stateDirectory;
after(() => fs.rmSync(stateDirectory, { recursive: true, force: true }));

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
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type Component = { handleInput?(data: string): void; dispose?(): void };

/** Load the extension into a fake Pi host that records every outbound call. */
function host(sessionId = `parent-${Math.random().toString(36).slice(2)}`) {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, Command>();
  let pickerKeys: string[] = [];
  const conversation: unknown[] = [];
  let status: string | undefined;
  let idle = true;

  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    registerMessageRenderer() {},
    registerEntryRenderer() {},
    registerCommand(name: string, command: Command) {
      commands.set(name, command);
    },
    registerShortcut() {},
    sendMessage(...args: unknown[]) {
      conversation.push({ sendMessage: args });
    },
    sendUserMessage(...args: unknown[]) {
      conversation.push({ sendUserMessage: args });
    },
    appendEntry(...args: unknown[]) {
      conversation.push({ appendEntry: args });
    },
    getThinkingLevel: () => "off",
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus(_key: string, text: string | undefined) {
        status = text;
      },
      notify() {},
      // Open the real picker, press the queued keys, then close it.
      async custom(
        factory: (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: (value: null) => void,
        ) => Component,
      ) {
        const component = factory(
          { requestRender() {}, terminal: { rows: 30 } },
          { fg: (_color: string, text: string) => text },
          { matches: () => false },
          () => {},
        );
        for (const key of pickerKeys) component.handleInput?.(key);
        pickerKeys = [];
        component.dispose?.();
        return null;
      },
    },
    sessionManager: { getSessionId: () => sessionId },
    isIdle: () => idle,
    isProjectTrusted: () => true,
  } as unknown as ExtensionCommandContext & ExtensionToolContext;

  subagentsExtension(pi, createStubRuntime);

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

  /** Poll through subagent-list, which must never count as collection. */
  const settled = async (id: string) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const list = await call("subagent-list", {});
      if (new RegExp(`${id} \\[(done|failed|cancelled)\\]`).test(list)) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`${id} did not settle`);
  };

  const spawn = async (prompt: string) => {
    const text = await call("subagent-spawn-direct", {
      name: "background",
      harness: "claude",
      prompt,
    });
    const id = /subagent (sa-[\w-]+)/.exec(text)?.[1];
    assert.ok(id, text);
    return id;
  };

  const pressInPicker = async (...keys: string[]) => {
    pickerKeys = keys;
    await commands.get("subagents")?.handler("", ctx);
  };

  return {
    conversation,
    status: () => status,
    setIdle(value: boolean) {
      idle = value;
    },
    start: () => emit("session_start"),
    settleAgent: () => emit("agent_settled"),
    shutdown: () => emit("session_shutdown"),
    call,
    spawn,
    settled,
    pressInPicker,
  };
}

test("completion while the parent is idle stays out of the conversation", async () => {
  const pi = host();
  await pi.start();
  try {
    const id = await pi.spawn("idle completion");
    await pi.settled(id);
    await pi.settleAgent();

    assert.deepEqual(pi.conversation, []);
    assert.match(pi.status() ?? "", /1 ready/);

    const collected = await pi.call("subagent-wait", { ids: [id] });
    assert.match(collected, /completed: idle completion/);
    assert.equal(pi.status(), undefined);
  } finally {
    await pi.shutdown();
  }
});

test("completion while the parent is busy never queues a follow-up, even after collection", async () => {
  const pi = host();
  await pi.start();
  try {
    pi.setIdle(false);
    const id = await pi.spawn("busy completion");
    await pi.settled(id);
    assert.match(pi.status() ?? "", /1 ready/);

    // Inspecting a settled run collects it; the parent then settles.
    const checked = await pi.call("subagent-check", { id });
    assert.match(checked, /completed: busy completion/);
    assert.equal(pi.status(), undefined);
    pi.setIdle(true);
    await pi.settleAgent();

    assert.deepEqual(pi.conversation, []);
  } finally {
    await pi.shutdown();
  }
});

test("a run that settles after a timed-out wait waits for collection", async () => {
  const pi = host();
  await pi.start();
  try {
    pi.setIdle(false);
    const id = await pi.spawn("slow after timeout");
    const timedOut = await pi.call("subagent-wait", {
      ids: [id],
      timeoutMs: 1,
    });
    assert.match(timedOut, /Wait timed out/);

    await pi.settled(id);
    pi.setIdle(true);
    await pi.settleAgent();
    assert.deepEqual(pi.conversation, []);
    assert.match(pi.status() ?? "", /1 ready/);

    assert.match(
      await pi.call("subagent-wait", { ids: [id] }),
      /completed: slow after timeout/,
    );
    assert.equal(pi.status(), undefined);
  } finally {
    await pi.shutdown();
  }
});

test("restored and resumed runs report only through tools and the indicator", async () => {
  const sessionId = "parent-recovery";
  const first = host(sessionId);
  await first.start();
  const id = await first.spawn("interrupted by shutdown");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.match(
    await first.call("subagent-list", {}),
    new RegExp(`${id} \\[running\\]`),
  );
  await first.shutdown();

  const second = host(sessionId);
  await second.start();
  try {
    await second.settled(id);
    // Recovered receipts never resume or announce themselves. The user cut
    // this run off by quitting, so it is not counted as awaiting collection.
    assert.deepEqual(second.conversation, []);
    assert.equal(second.status(), undefined);

    await second.call("subagent-resume", {
      id,
      prompt: "finish the task",
      mode: "continuation",
    });
    await second.settled(id);
    await second.settleAgent();

    assert.deepEqual(second.conversation, []);
    assert.match(second.status() ?? "", /1 ready/);
    assert.match(
      await second.call("subagent-wait", { ids: [id] }),
      /completed: Continue a recovered subagent task/,
    );
    assert.equal(second.status(), undefined);
  } finally {
    await second.shutdown();
  }
});

test("unseen failures stay in the footer across reloads until cleared in /subagents", async () => {
  const sessionId = "parent-clearing";
  const first = host(sessionId);
  await first.start();
  const failed = await first.spawn("REJECT:claude fail at startup");
  const done = await first.spawn("finish normally");
  await first.settled(failed);
  await first.settled(done);
  assert.match(first.status() ?? "", /1 ready · ■ 1 failed/);
  await first.shutdown();

  const second = host(sessionId);
  await second.start();
  try {
    await second.settled(failed);
    assert.match(second.status() ?? "", /1 ready · ■ 1 failed/);

    // `c` clears the selected run, `C` the rest.
    await second.pressInPicker("c");
    assert.match(second.status() ?? "", /^subagents: ■ 1 (ready|failed) · /);
    await second.pressInPicker("C");
    assert.equal(second.status(), undefined);
  } finally {
    await second.shutdown();
  }

  const third = host(sessionId);
  await third.start();
  try {
    await third.settled(failed);
    assert.equal(third.status(), undefined);
    // Clearing only affects the footer; the run stays inspectable.
    assert.match(
      await third.call("subagent-check", { id: failed }),
      /\[failed\][\s\S]*Error: model_not_found: claude rejected/,
    );
  } finally {
    await third.shutdown();
  }
});
