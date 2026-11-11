/**
 * Exit results are pull-only: a settling terminal never writes into the
 * conversation or starts a turn. The footer counts uncollected results until
 * a tool collects them or the user clears them in /ps. Runs the real
 * extension against real shell processes.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionToolContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { onActivity, type ActivityCounts } from "../shared/activity.ts";
import backgroundTerminals from "./index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type Component = { handleInput?(data: string): void; dispose?(): void };

const theme = { fg: (_color: string, text: string) => text };

/** Load the extension into a fake Pi host that records every outbound call. */
function host() {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, Command>();
  const conversation: unknown[] = [];
  let counts: ActivityCounts | undefined;
  let pickerKeys: string[] = [];
  let idle = true;

  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    registerMessageRenderer() {},
    registerCommand(name: string, command: Command) {
      commands.set(name, command);
    },
    registerShortcut() {},
    events: createEventBus(),
    sendMessage(...args: unknown[]) {
      conversation.push({ sendMessage: args });
    },
    sendUserMessage(...args: unknown[]) {
      conversation.push({ sendUserMessage: args });
    },
    appendEntry(...args: unknown[]) {
      conversation.push({ appendEntry: args });
    },
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    ui: {
      theme,
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
          theme,
          { matches: () => false },
          () => {},
        );
        for (const key of pickerKeys) component.handleInput?.(key);
        pickerKeys = [];
        component.dispose?.();
        return null;
      },
    },
    isIdle: () => idle,
  } as unknown as ExtensionCommandContext & ExtensionToolContext;

  onActivity(pi, (_source, published) => {
    counts = published;
  });
  backgroundTerminals(pi);

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

  const start = async (command: string) => {
    const text = await call("bg-start", { command, title: "job" });
    const id = /terminal (bt-\d+)/.exec(text)?.[1];
    assert.ok(id, text);
    return id;
  };

  /** Poll through bg-list, which must never count as collection. */
  const settled = async (id: string) => {
    for (let attempt = 0; attempt < 300; attempt++) {
      const list = await call("bg-list", {});
      if (new RegExp(`${id} \\[(done|failed|killed)\\]`).test(list)) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`${id} did not settle`);
  };

  return {
    conversation,
    /** What the footer was last told to show, without the zero counts. */
    shown: () =>
      Object.fromEntries(
        Object.entries(counts ?? {}).filter(([, count]) => count > 0),
      ),
    setIdle(value: boolean) {
      idle = value;
    },
    start,
    settled,
    call,
    sessionStart: () => emit("session_start"),
    settleAgent: () => emit("agent_settled"),
    shutdown: () => emit("session_shutdown"),
    async pressInPs(...keys: string[]) {
      pickerKeys = keys;
      await commands.get("ps")?.handler("", ctx);
    },
  };
}

async function withHost(run: (pi: ReturnType<typeof host>) => Promise<void>) {
  const pi = host();
  await pi.sessionStart();
  try {
    await run(pi);
  } finally {
    await pi.shutdown();
  }
}

test("an exit while the parent is idle stays out of the conversation", () =>
  withHost(async (pi) => {
    const id = await pi.start("echo idle-result");
    await pi.settled(id);
    await pi.settleAgent();

    assert.deepEqual(pi.conversation, []);
    assert.deepEqual(pi.shown(), { ready: 1 });

    assert.match(await pi.call("bg-wait", { ids: [id] }), /idle-result/);
    assert.deepEqual(pi.shown(), {});
  }));

test("an exit while the parent is busy never queues a follow-up, even after collection", () =>
  withHost(async (pi) => {
    pi.setIdle(false);
    const id = await pi.start("echo busy-result");
    await pi.settled(id);
    assert.deepEqual(pi.shown(), { ready: 1 });

    assert.match(await pi.call("bg-status", { id }), /busy-result/);
    assert.deepEqual(pi.shown(), {});
    pi.setIdle(true);
    await pi.settleAgent();

    assert.deepEqual(pi.conversation, []);
  }));

test("a terminal that exits after a timed-out wait waits for collection", () =>
  withHost(async (pi) => {
    pi.setIdle(false);
    const id = await pi.start("sleep 0.3; echo late-result");
    assert.match(
      await pi.call("bg-wait", { ids: [id], timeoutMs: 1 }),
      /Wait timed out/,
    );

    await pi.settled(id);
    pi.setIdle(true);
    await pi.settleAgent();
    assert.deepEqual(pi.conversation, []);
    assert.deepEqual(pi.shown(), { ready: 1 });

    assert.match(await pi.call("bg-wait", { ids: [id] }), /late-result/);
    assert.deepEqual(pi.shown(), {});
  }));

test("bg-kill reports the result itself, so nothing waits for collection", () =>
  withHost(async (pi) => {
    const id = await pi.start("sleep 30");
    assert.deepEqual(pi.shown(), { running: 1 });
    assert.match(await pi.call("bg-kill", { ids: [id] }), /Killed/);
    await pi.settleAgent();

    assert.deepEqual(pi.conversation, []);
    assert.deepEqual(pi.shown(), {});
  }));

test("failures stay in the footer until cleared in /ps", () =>
  withHost(async (pi) => {
    const failed = await pi.start("exit 3");
    const done = await pi.start("echo fine");
    await pi.settled(failed);
    await pi.settled(done);
    assert.deepEqual(pi.shown(), { ready: 1, failed: 1 });

    // `c` clears the selected terminal, `C` the rest.
    await pi.pressInPs("c");
    assert.equal(Object.keys(pi.shown()).length, 1);
    await pi.pressInPs("C");
    assert.deepEqual(pi.shown(), {});

    // Clearing only affects the footer; the result stays inspectable.
    assert.match(await pi.call("bg-status", { id: failed }), /exit 3/);
    assert.deepEqual(pi.conversation, []);
  }));
