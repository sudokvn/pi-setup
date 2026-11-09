import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import {
  type AgentToolResult,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  type ExtensionUIContext,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import herdr, { HERDR_MESSAGE } from "./index.ts";

const NOTE = "<hc>t7 reviewer exited (exit 0). Read: hc read t7</hc>";
const BATCH = `${NOTE}\n<hc>t8 is blocked (permission). See: hc read t8</hc>`;

/**
 * A real Pi session with this extension, a scripted model and one tool that
 * runs until released, so input can arrive while Pi is busy.
 */
async function start(t: test.TestContext, responses: FauxResponseStep[]) {
  const dir = await mkdtemp(path.join(tmpdir(), "herdr-test-"));
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
  // What the model was sent, as role and text, one list per request.
  const requests: string[][] = [];
  faux.setResponses(
    responses.map((step) => (context, options, state, model) => {
      requests.push(
        context.messages.flatMap((message) =>
          message.role === "user"
            ? [
                `user: ${typeof message.content === "string" ? message.content : message.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("")}`,
              ]
            : [],
        ),
      );
      return typeof step === "function"
        ? step(context, options, state, model)
        : step;
    }),
  );

  let toolStarted!: () => void;
  const busy = new Promise<void>((resolve) => (toolStarted = resolve));
  let release!: () => void;
  const wait = defineTool({
    name: "wait",
    label: "Wait",
    description: "Waits until released",
    parameters: Type.Object({}),
    execute: (_id, _params, signal) =>
      new Promise<AgentToolResult<undefined>>((done) => {
        release = () =>
          done({
            content: [{ type: "text", text: "waited" }],
            details: undefined,
          });
        signal?.addEventListener("abort", release);
        toolStarted();
      }),
  });

  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => pi.registerProvider(faux.provider),
      { name: "herdr", factory: herdr },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(dir),
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
    customTools: [wait],
    noTools: "builtin",
  });
  t.after(async () => {
    session.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  const errors: unknown[] = [];
  t.after(() => assert.deepEqual(errors, [], "extension errors"));
  // The extension only acts on input typed into the TUI. The footer status
  // is the one UI call it makes; the rest stays Pi's own no-op context.
  const statuses = new Map<string, string | undefined>();
  const uiContext: ExtensionUIContext = {
    ...session.extensionRunner.getUIContext(),
    setStatus: (key, text) => {
      statuses.set(key, text);
    },
  };
  await session.bindExtensions({
    mode: "tui",
    uiContext,
    onError: (error) => errors.push(error),
  });
  await session.setModel(faux.getModel());

  /** The transcript as `role[:customType] text` lines. */
  const transcript = () =>
    session.sessionManager.getBranch().flatMap((entry) => {
      if (entry.type === "custom_message") {
        return [`${entry.customType}: ${String(entry.content)}`];
      }
      if (entry.type !== "message") return [];
      const { message } = entry;
      if (message.role === "user") {
        const content = message.content;
        return [
          `user: ${typeof content === "string" ? content : content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("")}`,
        ];
      }
      if (message.role === "assistant") {
        return [
          `assistant: ${message.content.map((part) => (part.type === "text" ? part.text : part.type === "toolCall" ? `<${part.name}>` : "")).join("")}`,
        ];
      }
      return message.role === "system" ? [] : [message.role];
    });

  return {
    session,
    faux,
    requests,
    transcript,
    status: () => statuses.get(HERDR_MESSAGE),
    busy,
    release: () => release(),
  };
}

const callWait = () =>
  fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" });

test("an idle note becomes a Herdr message the model still answers", async (t) => {
  const { session, requests, transcript } = await start(t, [
    fauxAssistantMessage("reading t7"),
  ]);
  await session.prompt(NOTE);
  await session.waitForIdle();

  assert.deepEqual(transcript(), [
    `${HERDR_MESSAGE}: ${NOTE}`,
    "assistant: reading t7",
  ]);
  // The model receives exactly what it received as a typed user message.
  assert.deepEqual(requests, [[`user: ${NOTE}`]]);
});

test("a batch stays one message and one run; ordinary or image input stays the user's", async (t) => {
  const { session, faux, transcript } = await start(t, [
    fauxAssistantMessage("batch seen"),
    fauxAssistantMessage("ok"),
    fauxAssistantMessage("image seen"),
  ]);
  await session.prompt(BATCH);
  await session.waitForIdle();
  await session.prompt(`look at this:\n${NOTE}`);
  await session.prompt(NOTE, {
    images: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
  });

  const [batch, , mixed, , withImage, last] = transcript();
  assert.equal(batch, `${HERDR_MESSAGE}: ${BATCH}`);
  assert.equal(mixed, `user: look at this:\n${NOTE}`);
  // Pi may replace an unreadable image with a hint; the message stays the user's.
  assert.ok(withImage?.startsWith(`user: ${NOTE}`), withImage);
  assert.equal(last, "assistant: image seen");
  assert.equal(faux.state.callCount, 3);
});

test("a note typed while a tool runs steers into the next turn", async (t) => {
  const { session, requests, transcript, busy, release } = await start(t, [
    callWait(),
    fauxAssistantMessage("noted t7"),
  ]);
  const run = session.prompt("start");
  await busy;
  // InteractiveMode submits typed text this way while Pi is busy.
  await session.prompt(NOTE, { streamingBehavior: "steer" });
  // Dequeue clears Pi's queues; the note is not in them.
  assert.deepEqual(session.clearQueue(), { steering: [], followUp: [] });
  release();
  await run;
  await session.waitForIdle();

  assert.deepEqual(transcript(), [
    "user: start",
    "assistant: <wait>",
    "toolResult",
    `${HERDR_MESSAGE}: ${NOTE}`,
    "assistant: noted t7",
  ]);
  assert.deepEqual(requests.at(-1), ["user: start", `user: ${NOTE}`]);
});

test("a note typed during the final answer gets a turn of its own", async (t) => {
  let answering!: () => void;
  const requested = new Promise<void>((resolve) => (answering = resolve));
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => (finish = resolve));
  const { session, transcript } = await start(t, [
    async () => {
      answering();
      await finished;
      return fauxAssistantMessage("first answer");
    },
    fauxAssistantMessage("answer to t7"),
  ]);
  const run = session.prompt("start");
  await requested;
  await session.prompt(NOTE, { streamingBehavior: "steer" });
  finish();
  await run;
  await session.waitForIdle();

  assert.deepEqual(transcript(), [
    "user: start",
    "assistant: first answer",
    `${HERDR_MESSAGE}: ${NOTE}`,
    "assistant: answer to t7",
  ]);
});

test("a follow-up waits until the run would settle", async (t) => {
  const { session, transcript, status, busy, release } = await start(t, [
    callWait(),
    fauxAssistantMessage("finished"),
    fauxAssistantMessage("then the note"),
  ]);
  const run = session.prompt("start");
  await busy;
  assert.equal(status(), undefined);
  await session.prompt(NOTE, { streamingBehavior: "followUp" });
  // The footer shows the waiting note with the incoming marker.
  assert.equal(status(), "⇠ 1 queued");
  release();
  await run;
  await session.waitForIdle();
  assert.equal(status(), undefined);

  assert.deepEqual(transcript(), [
    "user: start",
    "assistant: <wait>",
    "toolResult",
    "assistant: finished",
    `${HERDR_MESSAGE}: ${NOTE}`,
    "assistant: then the note",
  ]);
});

test("Escape keeps a queued note in the session without starting a turn", async (t) => {
  const { session, faux, transcript, busy, release } = await start(t, [
    callWait(),
    fauxAssistantMessage("never requested"),
  ]);
  const run = session.prompt("start");
  await busy;
  await session.prompt(NOTE, { streamingBehavior: "steer" });
  // What InteractiveMode's Escape does: restore queued user text, then abort.
  session.clearQueue();
  const aborted = session.abort();
  release();
  await Promise.all([run, aborted]);
  await session.waitForIdle();

  assert.deepEqual(transcript(), [
    "user: start",
    "assistant: <wait>",
    "toolResult",
    "assistant: ", // Pi records the aborted response
    `${HERDR_MESSAGE}: ${NOTE}`,
  ]);
  assert.equal(faux.state.callCount, 1);
  assert.equal(faux.getPendingResponseCount(), 1);
});
