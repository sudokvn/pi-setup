import assert from "node:assert/strict";
import test from "node:test";
import {
  Markdown,
  stripTerminalSequences,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import { markTranscriptRoles } from "./transcript.ts";

const plain = (text: string) => text;
const theme: MarkdownTheme = {
  heading: plain,
  link: plain,
  linkUrl: plain,
  code: plain,
  codeBlock: plain,
  codeBlockBorder: plain,
  quote: plain,
  quoteBorder: plain,
  hr: plain,
  listBullet: plain,
  bold: plain,
  italic: plain,
  strikethrough: plain,
  underline: plain,
};

const context = {
  messageType: "user" as const,
  isStreaming: false,
  availableWidth: 60,
};

/** The rows Pi would draw for a user message, as plain text. */
function rows(markdown: string) {
  const transformed = markTranscriptRoles(markdown, context);
  return new Markdown(transformed, 0, 0, theme)
    .render(context.availableWidth)
    .map((row) => stripTerminalSequences(row).trimEnd());
}

test("every row of a user message carries the bar, including blank lines and wrapped rows", () => {
  const message =
    "fix the loader so it narrows the theme param instead of widening the Theme type\n\nthen add one test";
  const drawn = rows(message).filter((row) => row !== "");
  assert.ok(drawn.length >= 3, drawn.join("\n"));
  for (const row of drawn) {
    assert.match(row, /^│/, row);
  }
  // One quote, not two: the blank line between paragraphs is a bare bar.
  assert.ok(drawn.includes("│"), drawn.join("\n"));
});

test("a code fence inside a user message renders as a code block inside the quote", () => {
  const drawn = rows("run this\n\n```sh\npnpm check\n```");
  // Pi draws a code block as its fence lines (the frame) around indented code.
  assert.deepEqual(drawn, [
    "│ run this",
    "│",
    "│ ```sh",
    "│   pnpm check",
    "│ ```",
  ]);
});

test("assistant text is left alone", () => {
  const text = "Line 42 passes the string straight into the prop.";
  assert.equal(
    markTranscriptRoles(text, { ...context, messageType: "assistant" }),
    text,
  );
});
