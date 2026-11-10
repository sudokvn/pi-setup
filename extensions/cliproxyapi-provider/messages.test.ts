/**
 * Claude Fable 5.2 through Pi's own Anthropic Messages adapter and the mock CPA: what reaches CPA,
 * and whether the conversation CPA reconstructs still holds every earlier turn.
 */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  createModels,
  getPromptCacheTtlMs,
  InMemoryModelsStore,
  type AssistantMessage,
  type CacheRetention,
  type Message,
  type SimpleStreamOptions,
  type Tool,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { startMockCpa } from "./mock-cpa.ts";
import type { ProxyConfig } from "./src/config.ts";
import { createProxyProvider } from "./src/provider.ts";

type Json = { readonly [key: string]: unknown };
const isJson = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const FABLE = "claude-fable-5-2";
const THREADS_BETA = "message-threads-2026-08-12";

const tool = (name: string): Tool => ({
  name,
  description: `${name} tool`,
  parameters: Type.Object({ text: Type.String() }),
});

/** Text of every user message, in order, from Anthropic message params. */
function userTexts(messages: readonly unknown[]): string[] {
  return messages.flatMap((message) => {
    if (!isJson(message) || message.role !== "user") return [];
    const { content } = message;
    if (typeof content === "string") return [content];
    if (!Array.isArray(content)) return [];
    return content.flatMap((part) =>
      isJson(part) && part.type === "text" && typeof part.text === "string"
        ? [part.text]
        : [],
    );
  });
}

/** Each message's role, with the effort of effort-only system messages. */
function shape(messages: readonly unknown[]): unknown[] {
  return messages.map((message) =>
    isJson(message) && isJson(message.output_config)
      ? `${String(message.role)}:${String(message.output_config.effort)}`
      : isJson(message)
        ? message.role
        : message,
  );
}

const routes: ProxyConfig["routes"] = {
  [FABLE]: {
    promptCache: { short: 300, long: 3600 },
    fallbackModels: ["claude-opus-5"],
    compat: {
      supportsMidConvoEffort: true,
      supportsMidConvoSystemMessages: true,
      supportsMidConvoToolChanges: true,
      supportsMessageThreads: true,
      sendSessionAffinityHeaders: true,
    },
  },
  // The recommended default: CPA keeps its own short-retention handling.
  "claude-opus-5": {
    promptCache: { long: 3600 },
    compat: { supportsMidConvoEffort: true },
  },
};

let fixtures = 0;

async function fixture(t: TestContext) {
  const key = `messages-key-${++fixtures}`;
  const env = `CPA_MESSAGES_TEST_KEY_${fixtures}`;
  process.env[env] = key;
  const mock = await startMockCpa({
    apiKey: key,
    models: [{ id: FABLE }, { id: "claude-opus-5" }, { id: "claude-opus-5-5" }],
    // The reply names every user turn CPA would send upstream, so lost history shows in the text.
    reply: (merged) => ({ text: `seen: ${userTexts(merged).join(" | ")}` }),
  });
  const proxy = createProxyProvider({
    path: "test",
    provider: "proxy",
    name: "CLIProxyAPI",
    root: mock.root,
    apiKeyEnv: env,
    websocket: true,
    routes,
  });
  const collection = createModels({ modelsStore: new InMemoryModelsStore() });
  collection.setProvider(proxy.provider);
  assert.equal(
    (await collection.refresh({ allowNetwork: true })).errors.size,
    0,
  );
  t.after(async () => {
    delete process.env[env];
    await mock.close();
  });
  const turn = (
    messages: Message[],
    options: SimpleStreamOptions = {},
    id = FABLE,
  ) => {
    const model = collection.getModel("proxy", id);
    assert.ok(model, id);
    return collection.completeSimple(
      model,
      { systemPrompt: "Be brief.", messages, tools: [tool("echo")] },
      { sessionId: "session-1", ...options },
    );
  };
  const last = () => {
    const request = mock.requests.at(-1);
    assert.ok(request);
    return request;
  };
  return { mock, collection, turn, last };
}

const user = (text: string): Message => ({
  role: "user",
  content: text,
  timestamp: Date.now(),
});
const text = (message: AssistantMessage) => {
  assert.equal(message.stopReason, "stop", message.errorMessage);
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
};

test("Fable 5.2 continues a message thread with effort markers, system and tool changes", async (t) => {
  const f = await fixture(t);
  const u1 = user("first");
  const a1 = await f.turn([u1], { reasoning: "high" });
  assert.equal(text(a1), "seen: first");
  const create = f.last();
  assert.deepEqual(create.body.thread, { type: "create" });

  const u2 = user("second");
  const a2 = await f.turn([u1, a1, u2], { reasoning: "low" });
  assert.equal(text(a2), "seen: first | second");
  const effort = f.last();
  assert.deepEqual(effort.body.thread, {
    type: "continue",
    previous_message_id: a1.responseId,
  });
  // Only the new turn went over the wire; the thread supplied the rest.
  assert.deepEqual(userTexts(effort.body.messages as unknown[]), ["second"]);
  assert.equal(effort.body.system, undefined);
  assert.equal(effort.body.tools, undefined);
  // The first reply stays bound to the effort it ran with; the new one runs at the new level.
  assert.deepEqual(shape(effort.merged), [
    "user",
    "system:high",
    "assistant",
    "user",
    "system:low",
  ]);

  // Thinking "off" is not available on an always-adaptive model: the request stays adaptive.
  const change: Message = {
    role: "system",
    content: "Prefer the grep tool.",
    toolsAdded: [tool("grep")],
    timestamp: Date.now(),
  };
  const a3 = await f.turn([u1, a1, u2, a2, change, user("third")]);
  assert.equal(text(a3), "seen: first | second | third");
  const tools = f.last();
  assert.equal(isJson(tools.body.thread) && tools.body.thread.type, "continue");
  const system = (tools.body.messages as unknown[]).find(
    (message) =>
      isJson(message) &&
      message.role === "system" &&
      Array.isArray(message.content) &&
      message.content.length > 0,
  );
  assert.ok(isJson(system) && Array.isArray(system.content));
  assert.deepEqual(
    system.content.map((block) =>
      isJson(block) ? [block.type, block.text ?? undefined] : block,
    ),
    [
      ["text", "Prefer the grep tool."],
      ["tool_addition", undefined],
    ],
  );

  for (const request of f.mock.requests) {
    assert.deepEqual(request.body.thinking, {
      type: "adaptive",
      display: "summarized",
      block_binding: { prefix_mismatch_behavior: "drop_block" },
    });
    // The top-level effort stays fixed for the cache; the markers carry the real level.
    assert.deepEqual(request.body.output_config, { effort: "low" });
    assert.deepEqual(request.body.prompt_cache_options, { mode: "explicit" });
    assert.deepEqual(request.body.fallbacks, [{ model: "claude-opus-5" }]);
    assert.equal(request.headers?.["x-session-affinity"], "session-1");
    const betas = String(request.headers?.["anthropic-beta"]).split(",");
    for (const beta of [
      THREADS_BETA,
      "advanced-tool-use-2025-11-20",
      "mid-conversation-output-config-2026-07-01",
      "thinking-binding-controls-2026-08-01",
      "inline-tools-2026-09-15",
      "server-side-fallback-2026-07-01",
    ]) {
      assert.ok(betas.includes(beta), `${beta} in ${betas.join()}`);
    }
  }
});

test("thread beta pinning preserves header precedence and explicit beta suppression", async (t) => {
  const f = await fixture(t);
  const model = f.collection.getModel("proxy", FABLE);
  assert.ok(model);
  const cases: {
    modelBeta: string;
    requestBeta?: string | null;
    expected: string[];
  }[] = [
    {
      modelBeta: `model-beta,${THREADS_BETA}`,
      expected: ["model-beta", THREADS_BETA, "advanced-tool-use-2025-11-20"],
    },
    {
      modelBeta: `model-beta,${THREADS_BETA}`,
      requestBeta: `request-beta,${THREADS_BETA}`,
      expected: ["request-beta", THREADS_BETA, "advanced-tool-use-2025-11-20"],
    },
    {
      modelBeta: `model-beta,${THREADS_BETA}`,
      requestBeta: "request-only-beta",
      expected: ["request-only-beta"],
    },
    {
      modelBeta: `model-beta,${THREADS_BETA}`,
      requestBeta: null,
      expected: [],
    },
  ];
  for (const [index, { modelBeta, requestBeta, expected }] of cases.entries()) {
    const reply = await f.collection.completeSimple(
      { ...model, headers: { "AnThRoPiC-BeTa": modelBeta, "x-model": "kept" } },
      { messages: [user("first")] },
      {
        sessionId: `headers-${index}`,
        headers: {
          "x-request": "kept",
          ...(requestBeta !== undefined
            ? { "ANTHROPIC-BETA": requestBeta }
            : {}),
        },
      },
    );
    assert.equal(reply.stopReason, "stop", reply.errorMessage);
    const headers = f.last().headers;
    assert.equal(headers?.["x-model"], "kept");
    assert.equal(headers?.["x-request"], "kept");
    if (expected.length === 0) {
      assert.equal(headers?.["anthropic-beta"], undefined);
    } else {
      assert.deepEqual(
        String(headers?.["anthropic-beta"]).split(","),
        expected,
      );
    }
  }
  await f.turn([user("unthreaded")], {}, "claude-opus-5");
  assert.ok(
    !String(f.last().headers?.["anthropic-beta"])
      .split(",")
      .includes("advanced-tool-use-2025-11-20"),
  );
});

test("Fable 5.2 resends the full history after an edit or a lost thread", async (t) => {
  const f = await fixture(t);
  const u1 = user("first");
  const a1 = await f.turn([u1]);
  const u2 = user("second");

  // An edited earlier turn cannot continue the thread, so the full history starts a new one.
  const edited = await f.turn([user("first, edited"), a1, u2]);
  assert.equal(text(edited), "seen: first, edited | second");
  assert.deepEqual(f.last().body.thread, { type: "create" });
  assert.deepEqual(userTexts(f.last().body.messages as unknown[]), [
    "first, edited",
    "second",
  ]);

  // CPA or Anthropic lost the thread: Pi resends the same request in full once.
  f.mock.faults.threadNotFound = true;
  const u3 = user("third");
  const resent = await f.turn([user("first, edited"), a1, u2, edited, u3]);
  assert.equal(text(resent), "seen: first, edited | second | third");
  assert.deepEqual(f.last().body.thread, { type: "create" });
  assert.ok(f.last().body.system, "a new thread carries the system prompt");
  assert.deepEqual(
    resent.diagnostics?.map((diagnostic) => diagnostic.type),
    ["anthropic_thread_fallback"],
  );
});

test("replays the full history once when CPA itself lost the thread state", async (t) => {
  const f = await fixture(t);
  const u1 = user("first");
  const a1 = await f.turn([u1]);
  f.mock.faults.cpaThreadStateLost = true;
  const a2 = await f.turn([u1, a1, user("second")]);
  assert.equal(text(a2), "seen: first | second");
  assert.deepEqual(f.last().body.thread, { type: "create" });
  assert.ok(
    String(f.last().headers?.["anthropic-beta"])
      .split(",")
      .includes("advanced-tool-use-2025-11-20"),
  );
  assert.deepEqual(
    a2.diagnostics?.map((diagnostic) => diagnostic.type),
    ["anthropic_thread_fallback"],
  );
  // The new thread continues normally afterwards.
  const a3 = await f.turn([u1, a1, user("second"), a2, user("third")]);
  assert.equal(text(a3), "seen: first | second | third");
  assert.deepEqual(f.last().body.thread, {
    type: "continue",
    previous_message_id: a2.responseId,
  });

  // Any other 404 reaches Pi unchanged.
  const fable = f.collection.getModel("proxy", FABLE);
  assert.ok(fable);
  const missing = await f.collection.completeSimple(
    { ...fable, baseUrl: `${f.mock.root}/elsewhere` },
    { messages: [user("first")] },
    { sessionId: "session-404" },
  );
  assert.equal(missing.stopReason, "error");
  assert.match(
    missing.errorMessage ?? "",
    /404.*no route \/elsewhere\/v1\/messages/,
  );
  assert.equal(missing.diagnostics, undefined);
});

test("prices a server-side fallback reply as the fallback route and never continues it", async (t) => {
  const f = await fixture(t);
  const fable = f.collection.getModel("proxy", FABLE);
  const opus = f.collection.getModel("proxy", "claude-opus-5");
  assert.ok(fable && opus);

  f.mock.faults.fallbackModel = "claude-opus-5";
  const u1 = user("first");
  const a1 = await f.turn([u1]);
  assert.equal(a1.responseModel, "claude-opus-5");
  assert.ok(opus.cost.input !== fable.cost.input);
  // Mock usage: 25 input, 12 output and 100 cache-read tokens; prices are per million.
  const micro = (usd: number) => Math.round(usd * 1e12);
  const { cost } = a1.usage;
  assert.deepEqual(
    [cost.input, cost.output, cost.cacheRead].map(micro),
    [
      (25 * opus.cost.input) / 1e6,
      (12 * opus.cost.output) / 1e6,
      (100 * opus.cost.cacheRead) / 1e6,
    ].map(micro),
  );

  // Anthropic does not store fallback replies in the thread, so the next turn starts a new one.
  const a2 = await f.turn([u1, a1, user("second")]);
  assert.equal(text(a2), "seen: first | second");
  assert.deepEqual(f.last().body.thread, { type: "create" });
});

test("explicit cache mode follows the retention tier the request uses", async (t) => {
  const f = await fixture(t);
  const sent = async (id: string, cacheRetention: CacheRetention) => {
    await f.turn(
      [user("first")],
      { cacheRetention, sessionId: `${id}-${cacheRetention}` },
      id,
    );
    return f.last().body;
  };

  // Long-only route, short retention: CPA keeps its own cache handling, one hour when cloaked.
  const short = await sent("claude-opus-5", "short");
  assert.equal(short.prompt_cache_options, undefined);
  assert.match(JSON.stringify(short), /"cache_control":\{"type":"ephemeral"\}/);
  const long = await sent("claude-opus-5", "long");
  assert.deepEqual(long.prompt_cache_options, { mode: "explicit" });
  assert.match(JSON.stringify(long.system), /"ttl":"1h"/);
  // No markers on purpose: explicit mode keeps CPA from adding its own.
  const none = await sent("claude-opus-5", "none");
  assert.deepEqual(none.prompt_cache_options, { mode: "explicit" });
  assert.doesNotMatch(JSON.stringify(none), /cache_control/);

  // Pi warms only the tier with a lifetime.
  const opus = f.collection.getModel("proxy", "claude-opus-5");
  assert.ok(opus);
  assert.equal(
    getPromptCacheTtlMs(opus, { cacheRetention: "short" }),
    undefined,
  );
  assert.equal(
    getPromptCacheTtlMs(opus, { cacheRetention: "long" }),
    3_600_000,
  );

  // A route without a lifetime is unchanged for every tier.
  for (const retention of ["short", "long", "none"] as const) {
    const body = await sent("claude-opus-5-5", retention);
    assert.equal(body.prompt_cache_options, undefined, retention);
  }
});

test("only routes with a prompt cache lifetime own their cache markers, and caller hooks compose", async (t) => {
  const f = await fixture(t);
  const seen: unknown[] = [];
  await f.turn([user("first")], {
    cacheRetention: "long",
    onPayload: (payload) => {
      seen.push(isJson(payload) ? payload.prompt_cache_options : undefined);
      return isJson(payload)
        ? { ...payload, metadata: { user_id: "hooked" } }
        : undefined;
    },
  });
  const long = f.last().body;
  assert.deepEqual(seen, [{ mode: "explicit" }]);
  assert.deepEqual(long.metadata, { user_id: "hooked" });
  assert.deepEqual(long.prompt_cache_options, { mode: "explicit" });
  // Long retention writes Anthropic's one-hour marker; CPA keeps it as written in explicit mode.
  assert.match(JSON.stringify(long.system), /"ttl":"1h"/);

  await f.turn([user("first")], { sessionId: "session-2" });
  assert.doesNotMatch(JSON.stringify(f.last().body), /"ttl"/);

  // Pi's hook contract holds: `undefined` keeps the (possibly mutated) payload, and any other
  // value replaces it, so the hook has the final say over the marker too.
  await f.turn([user("first")], {
    sessionId: "session-3",
    onPayload: (payload) => {
      if (isJson(payload))
        Reflect.set(payload, "metadata", { user_id: "mutated" });
      return undefined;
    },
  });
  assert.deepEqual(f.last().body.metadata, { user_id: "mutated" });
  assert.deepEqual(f.last().body.prompt_cache_options, { mode: "explicit" });
  await f.turn([user("first")], {
    sessionId: "session-4",
    onPayload: () => null,
  });
  // Pi adds only `stream` and its own `thread` field to a replacement.
  assert.deepEqual(Object.keys(f.last().body).sort(), ["stream", "thread"]);

  // Opus 5.5 has no configured lifetime: CPA keeps owning its markers, and Pi does not warm it.
  const opus = f.collection.getModel("proxy", "claude-opus-5-5");
  assert.equal(opus?.promptCache, undefined);
  await f.turn([user("first")], {}, "claude-opus-5-5");
  assert.equal(f.last().body.prompt_cache_options, undefined);
});
