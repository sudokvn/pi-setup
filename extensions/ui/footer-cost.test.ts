import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import ui from "./index.ts";

type FooterFactory = NonNullable<
  Parameters<ExtensionUIContext["setFooter"]>[0]
>;

function usage(cost: number): Usage {
  return {
    input: 1_000,
    output: 100,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 1_100,
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

function assistant(cost: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Done." }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-test",
    usage: usage(cost),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function user(text: string) {
  return { role: "user" as const, content: text, timestamp: Date.now() };
}

/** Starts the real UI extension in TUI mode and returns its footer renderer. */
function renderFooter(t: TestContext, sessionManager: SessionManager) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
      handlers.set(event, handler);
    },
    events: { emit() {} },
    registerMarkdownTransformer() {},
    registerToolRenderer() {},
    getThinkingLevel: () => "off",
  };
  let footer: FooterFactory | undefined;
  const ctx = {
    mode: "tui",
    cwd: "/work/project",
    model: undefined,
    getContextUsage: () => undefined,
    sessionManager,
    ui: {
      setHeader() {},
      setTitle() {},
      setFooter: (factory: FooterFactory) => {
        footer = factory;
      },
    },
  };
  ui(pi as unknown as ExtensionAPI, () => {});
  handlers.get("session_start")?.(
    { type: "session_start" },
    ctx as unknown as ExtensionContext,
  );
  assert.ok(footer, "the UI extension installs a footer in TUI mode");
  const component = footer(
    { requestRender() {} } as unknown as Parameters<FooterFactory>[0],
    {
      fg: (_color: string, text: string) => text,
    } as unknown as Parameters<FooterFactory>[1],
    {
      getExtensionStatuses: () => new Map(),
    } as unknown as Parameters<FooterFactory>[2],
  );
  const branchReads = t.mock.method(sessionManager, "getBranch");
  return {
    render: () => component.render(200)[0],
    branchReads: () => branchReads.mock.callCount(),
  };
}

test("footer cost includes every usage-bearing entry and shows background cache warming on the next render", (t) => {
  const session = SessionManager.inMemory("/work/project");
  session.appendMessage(user("Build it."));
  const response = session.appendMessage(assistant(0.1));
  session.appendMessage({
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "codemode",
    content: [{ type: "text", text: "ok" }],
    usage: usage(0.02),
    isError: false,
    timestamp: Date.now(),
  });
  session.appendCompaction(
    "Summary.",
    response,
    5_000,
    undefined,
    false,
    usage(0.03),
  );
  const footer = renderFooter(t, session);
  assert.match(footer.render(), /\$0\.15$/);

  // Repeated frames reuse the total until an append moves the leaf.
  const reads = footer.branchReads();
  footer.render();
  assert.equal(footer.branchReads(), reads);

  // Cache warming appends usage while idle and only requests a render: no
  // extension event refreshes the footer.
  session.appendUsage("cache_warm", "openai", "gpt-test", usage(0.04));
  assert.match(footer.render(), /\$0\.19$/);
  assert.equal(footer.branchReads(), reads + 1);
});

test("footer cost follows the current branch, including the summary that switched to it", (t) => {
  const session = SessionManager.inMemory("/work/project");
  session.appendMessage(user("First."));
  const first = session.appendMessage(assistant(1));
  session.appendMessage(user("Second."));
  session.appendMessage(assistant(2));
  const footer = renderFooter(t, session);
  assert.match(footer.render(), /\$3\.00$/);

  session.branchWithSummary(
    first,
    "Abandoned work.",
    undefined,
    false,
    usage(0.25),
  );
  assert.match(footer.render(), /\$1\.25$/);
});
