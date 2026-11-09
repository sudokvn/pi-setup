import assert from "node:assert/strict";
import test from "node:test";
import {
  Markdown,
  stripTerminalSequences,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import { stripQuoteBars, unwrapSelection } from "./unwrap.ts";

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

/** What Pi copies today: the rendered rows as plain text, trimmed and joined with newlines. */
function selectAll(markdown: string, width: number, pad = 0) {
  return new Markdown(markdown, pad, 0, theme)
    .render(width)
    .map((row) => stripTerminalSequences(row).trimEnd())
    .join("\n");
}

function unwrap(markdown: string, width: number, pad = 0) {
  return unwrapSelection(selectAll(markdown, width, pad), {
    width,
    rightPad: pad,
    firstColumn: 0,
  });
}

test("keeps real line breaks, paragraphs and list items", () => {
  const markdown = [
    "Short line.  ",
    "Next line.",
    "",
    "- first item that is long enough to wrap",
    "- second item",
  ].join("\n");

  assert.equal(
    unwrap(markdown, 24),
    [
      "Short line.",
      "Next line.",
      "",
      "- first item that is long enough to wrap",
      "- second item",
    ].join("\n"),
  );
});

test("joins a word split across rows without adding spaces", () => {
  const url = "see https://example.com/a/very/long/path/that/cannot/fit";
  assert.equal(unwrap(url, 20), url);
});

test("copies a quoted user message without the bars, wrapped rows joined", () => {
  const message =
    "fix the loader so it narrows the theme param instead of widening it\n\nthen add one test";
  const quoted = message
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
  assert.equal(stripQuoteBars(unwrap(quoted, 30)), message);
});

test("a quote inside the user's message keeps its own bar", () => {
  assert.equal(
    stripQuoteBars("│ │ Understood.\n│\n│ just another test"),
    "│ Understood.\n\njust another test",
  );
});

test("keeps the bars when the selection mixes quoted and plain rows", () => {
  const mixed = "│ quoted\nplain";
  assert.equal(stripQuoteBars(mixed), mixed);
});

test("counts unselected columns of the first row", () => {
  const rows = "wraps here\nand continues";
  assert.equal(
    unwrapSelection(rows, { width: 24, rightPad: 0, firstColumn: 14 }),
    "wraps here and continues",
  );
  assert.equal(
    unwrapSelection(rows, { width: 24, rightPad: 0, firstColumn: 0 }),
    rows,
  );
});
