import assert from "node:assert/strict";
import test from "node:test";
import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionUIContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { NO_ACTIVITY, publishActivity } from "../shared/activity.ts";
import { renderFooterLine, type FooterState } from "./footer-line.ts";
import ui from "./index.ts";
import { emptyVcsInfoState } from "./vcs/state.ts";

const HOME = "/home/kevin";
const T = "\uF120";
const R = "\u{F06A9}";
const B = "\uF02E";

const plain = { fg: (_color: string, text: string) => text } as Theme;
/** Marks each coloured run, to check which parts stand out. */
const tagged = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
} as Theme;

// A terminal that supports hyperlinks wraps the PR number in an OSC 8 link.
const withoutLinks = (line: string) =>
  // eslint-disable-next-line no-control-regex
  line.replace(/\u001b\]8;;[^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "");

function state(folder: string, overrides: Partial<FooterState> = {}) {
  return {
    cwd: `${HOME}/${folder}`,
    home: HOME,
    vcs: {
      ...emptyVcsInfoState(),
      isRepository: true,
      kind: "jj",
      changeId: { prefix: "n", rest: "orxulrz" },
      nameRoot: `${HOME}/Projects/roomvibes`,
      changedFiles: 3,
    },
    statuses: [],
    activity: {
      terminals: { ...NO_ACTIVITY, running: 1 },
      subagents: { ...NO_ACTIVITY, running: 2 },
    },
    modelId: "gpt-6.1-sol-fast",
    thinking: "high",
    contextPercent: 76,
    ...overrides,
  } satisfies FooterState;
}

/** The line always fills the pane: left group at the start, right group at the end. */
function assertLine(
  footer: FooterState,
  width: number,
  left: string,
  right: string,
) {
  const line = withoutLinks(renderFooterLine(plain, footer, width));
  assert.equal(visibleWidth(line), width);
  assert.equal(line.trimEnd(), line);
  assert.equal(line.slice(0, line.length - right.length).trimEnd(), left);
  assert.ok(line.endsWith(right), line);
}

test("a wide pane shows everything, with background work left of the model", () => {
  const model = "gpt-6.1-sol-fast  high   76%";
  const idle = { terminals: NO_ACTIVITY, subagents: NO_ACTIVITY };
  const location = "~/Projects/roomvibes   @ norxulrz ±3";

  assertLine(
    state("Projects/roomvibes", { activity: idle }),
    140,
    location,
    model,
  );
  assertLine(
    state("Projects/roomvibes", {
      vcs: {
        ...state("Projects/roomvibes").vcs,
        refs: ["footer-status"],
        pullRequest: {
          number: 482,
          url: "https://example.test",
          isDraft: false,
        },
      },
      statuses: ["⇠ 2 queued"],
      activity: {
        terminals: { running: 2, ready: 1, failed: 0, cancelled: 1 },
        subagents: { running: 3, ready: 2, failed: 1, cancelled: 0 },
      },
    }),
    140,
    `${location}   ${B}  footer-status   #482   ⇠ 2 queued`,
    `${T}  ● 2 ✓ 1 ○ 1   ${R}  ● 3 ✓ 2 ✗ 1   ${model}`,
  );
});

test("a narrow pane gives up only as much as it needs, in order", () => {
  const work = `${T}  ● 1  ${R}  ● 2  gpt-6.1-sol-fast`;

  // Tighter gaps are enough for the repository root.
  assertLine(
    state("Projects/roomvibes"),
    80,
    "~/Projects/roomvibes  @ norxulrz ±3",
    `${work}  high  76%`,
  );
  // Then the thinking level, the change ID and one parent folder.
  assertLine(
    state("Projects/roomvibes/apps/player"),
    80,
    "~/P/roomvibes/apps/player  @ norx ±3",
    `${work}  76%`,
  );
  // A deeper path shortens a second parent; a dot folder keeps its dot.
  assertLine(
    state("Projects/.workspaces/kumio/auth-foundation", {
      vcs: {
        ...state("").vcs,
        nameRoot: `${HOME}/Projects/.workspaces/kumio`,
      },
    }),
    80,
    "~/P/.w/kumio/auth-foundation  @ norx ±3",
    `${work}  76%`,
  );
});

test("background work and the context share outlast everything else", () => {
  const line = renderFooterLine(plain, state("Projects/roomvibes"), 34);
  assert.equal(visibleWidth(line), 34);
  assert.ok(line.endsWith(`${T}  ● 1  ${R}  ● 2  76%`), line);
  assert.ok(line.startsWith("~/P/roomvib"), line);
});

test("the repository stands out from the folders above it", () => {
  const line = renderFooterLine(
    tagged,
    state("Projects/.workspaces/kumio/auth-foundation", {
      vcs: {
        ...state("").vcs,
        nameRoot: `${HOME}/Projects/.workspaces/kumio`,
      },
    }),
    400,
  );
  assert.ok(
    line.startsWith(
      "<muted>~/Projects/.workspaces/</muted><text>kumio/auth-foundation</text>",
    ),
    line,
  );
  // The unique prefix of the change ID is the part to type.
  assert.ok(line.includes("<text>n</text><muted>orxulrz</muted>"), line);

  const outside = renderFooterLine(
    tagged,
    state("Documents/notes", { vcs: emptyVcsInfoState() }),
    400,
  );
  assert.ok(
    outside.startsWith("<muted>~/Documents/</muted><text>notes</text>"),
    outside,
  );
});

type FooterFactory = NonNullable<
  Parameters<ExtensionUIContext["setFooter"]>[0]
>;

test("the footer stays one row while other extensions report work and status", () => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
      handlers.set(event, handler);
    },
    events: createEventBus(),
    registerMarkdownTransformer() {},
    registerToolRenderer() {},
    getThinkingLevel: () => "off",
  } as unknown as ExtensionAPI;
  let footer: FooterFactory | undefined;
  let renders = 0;
  const ctx = {
    mode: "tui",
    cwd: "/work/project",
    model: undefined,
    getContextUsage: () => undefined,
    ui: {
      setHeader() {},
      setTitle() {},
      setFooter: (factory: FooterFactory) => {
        footer = factory;
      },
    },
  } as unknown as ExtensionContext;

  ui(pi, () => {});
  handlers.get("session_start")?.({ type: "session_start" }, ctx);
  assert.ok(footer, "the UI extension installs a footer in TUI mode");
  const component = footer(
    {
      requestRender: () => {
        renders += 1;
      },
    } as unknown as Parameters<FooterFactory>[0],
    plain,
    {
      getExtensionStatuses: () => new Map([["herdr", "⇠ 2 queued"]]),
    } as unknown as Parameters<FooterFactory>[2],
  );

  const running = { ...NO_ACTIVITY, running: 2 };
  publishActivity(pi, "subagents", running);
  // Sources publish on every change; an unchanged count is not a redraw.
  publishActivity(pi, "subagents", running);
  assert.equal(renders, 1);

  const lines = component.render(120);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\/work\/project {3}⇠ 2 queued {2,}\S+ {2}● 2$/);
});
