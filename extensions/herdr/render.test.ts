import assert from "node:assert/strict";
import test from "node:test";
import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { renderHerdrMessage } from "./render.ts";

type Theme = Parameters<MessageRenderer>[2];

const colors: string[] = [];
const theme = {
  fg: (color: string, text: string) => {
    colors.push(color);
    return text;
  },
} as Theme;

function rows(content: string, expanded = false) {
  colors.length = 0;
  const component = renderHerdrMessage(
    {
      role: "custom",
      customType: "herdr",
      content,
      display: true,
      timestamp: 0,
    },
    {
      expanded,
      outputPad: 1,
      keyHint: (_binding, description) => `ctrl+o ${description}`,
      keyText: () => "ctrl+o",
    },
    theme,
  );
  return component
    ?.render(100)
    .map((row) => stripTerminalSequences(row).trimEnd());
}

test("a note is one marked line: who in text, what muted, the hint dim", () => {
  assert.deepEqual(
    rows("<hc>t7 reviewer is blocked (permission). See: hc read t7</hc>"),
    [" ⇠ t7 reviewer is blocked (permission) · hc read t7"],
  );
  // The marker carries the outcome; the words carry it too.
  assert.equal(colors[0], "warning");

  rows("<hc>t7 reviewer exited (exit 0). Read: hc read t7</hc>");
  assert.equal(colors[0], "success");

  // A signal is a failure too, and "hit" starts what happened, not a name.
  assert.deepEqual(
    rows("<hc>t7 reviewer exited (signal 9). Read: hc read t7</hc>"),
    [" ⇠ t7 reviewer exited (signal 9) · hc read t7"],
  );
  assert.equal(colors[0], "error");
  assert.deepEqual(
    rows("<hc>t7 reviewer hit an error: spawn failed. See: hc read t7</hc>"),
    [" ⇠ t7 reviewer hit an error: spawn failed · hc read t7"],
  );
  assert.deepEqual(colors.slice(0, 2), ["error", "text"]);
});

test("program output stays behind the row until expanded", () => {
  const exited =
    "<hc>t7 exited (exit 3). Last lines:\nFAIL x.test.ts\nRead: hc read t7</hc>";
  assert.deepEqual(rows(exited), [
    " ⇠ t7 exited (exit 3) · +1 line, ctrl+o to expand · hc read t7",
  ]);
  assert.equal(colors[0], "error");
  assert.deepEqual(rows(exited, true), [
    " ⇠ t7 exited (exit 3) · hc read t7",
    "   FAIL x.test.ts",
  ]);
});

test("a batch stacks its rows without blank lines", () => {
  assert.deepEqual(
    rows(
      "<hc>t9 simplifier is blocked (permission). See: hc read t9</hc>\n<hc>t11 bench exited (exit 3). Read: hc read t11</hc>",
    ),
    [
      " ⇠ t9 simplifier is blocked (permission) · hc read t9",
      " ⇠ t11 bench exited (exit 3) · hc read t11",
    ],
  );
});

test("a message names its sender above the indented text, without the user's bar", () => {
  const drawn = rows(
    '<hc from="t3 lead" reach="hc send t3 when done or stuck">Review x.rs\u001b[2J\nthen report</hc>',
  );
  assert.deepEqual(drawn, [
    " ⇠ t3 lead · reply: hc send t3",
    "   Review x.rs[2J",
    "   then report",
  ]);
  assert.ok(drawn?.every((row) => !row.trimStart().startsWith("│")));
  // No outcome to show: the marker takes the text colour.
  assert.equal(colors[0], "text");
});

test("anything else falls back to Pi's default rendering", () => {
  assert.equal(rows("plain text"), undefined);
});
