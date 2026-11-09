import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { parseHerdrInput, type HerdrEnvelope } from "./envelope.ts";

type Theme = Parameters<MessageRenderer>[2];
type Options = Parameters<MessageRenderer>[1];

// Typed text can carry terminal control sequences; drawing them would smear
// the transcript. Newlines and tabs are content.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

const clean = (text: string) => text.replace(CONTROL, "");

/**
 * One glyph says "this came in from another agent"; its colour carries the
 * outcome, and the words carry it too, so colour is never the only signal.
 * Tool rows keep ✓ and ✗ for the agent's own work.
 */
export const INCOMING = "⇠";
const SEPARATOR = " · ";
const BODY_INDENT = 2;

/** Where a note points the reader, and the sentence before it. */
const POINTER = /(?:\. |\n)((?:See|Read): hc read \S+)$/;
/** The first word of what happened; an optional name stands before it. */
const VERB = /(?:^|\s)(?:exited|hit|is|was|has|finished|stopped)\b/;

/** The outcome colour for a note, read from its wording. */
function outcome(text: string): "success" | "error" | "warning" | "muted" {
  if (/\(exit 0\)/.test(text)) return "success";
  if (/\((?:exit|signal) \d+\)|\bfailed\b|\berror\b/.test(text)) return "error";
  if (/\bblocked\b/.test(text)) return "warning";
  return "muted";
}

function row(theme: Theme, pad: number, text: string) {
  return new Text(text, pad, 0);
}

function renderNote(
  envelope: Extract<HerdrEnvelope, { kind: "note" }>,
  { expanded, outputPad, keyHint }: Options,
  theme: Theme,
) {
  const body = clean(envelope.body);
  const pointer = POINTER.exec(body);
  const hint = pointer?.[1]?.replace(/^(?:See|Read): /, "");
  const text = pointer ? body.slice(0, pointer.index) : body;
  // "Last lines:" announces the output; the expand hint and indent do that here.
  const [headline = "", ...rest] = text
    .replace(/\.? Last lines:$/m, "")
    .split("\n");
  // The parser guarantees the headline starts with the address. Upstream puts
  // an optional name after it, then a verb; the name is what comes before.
  const after = headline.slice(envelope.address.length).trimStart();
  const verb = after.search(VERB);
  const name = verb > 0 ? after.slice(0, verb) : "";
  const who = name ? `${envelope.address} ${name}` : envelope.address;
  const what = after.slice(name.length).trimStart();

  const parts = [
    `${theme.fg(outcome(headline), INCOMING)} ${theme.fg("text", who)} ${theme.fg("muted", what)}`,
  ];
  const lines = rest.filter((line) => line.trim());
  if (lines.length > 0 && !expanded) {
    const more = `+${lines.length} ${lines.length === 1 ? "line" : "lines"}, ${keyHint("app.tools.expand", "to expand")}`;
    parts.push(theme.fg("dim", more));
  }
  if (hint) parts.push(theme.fg("dim", hint));

  const container = new Container();
  container.addChild(
    row(theme, outputPad, parts.join(theme.fg("dim", SEPARATOR))),
  );
  if (lines.length > 0 && expanded) {
    container.addChild(
      row(theme, outputPad + BODY_INDENT, theme.fg("dim", lines.join("\n"))),
    );
  }
  return container;
}

function renderMessage(
  envelope: Extract<HerdrEnvelope, { kind: "message" }>,
  { outputPad }: Options,
  theme: Theme,
) {
  // A message has no outcome, so its marker takes the text colour.
  let header = `${theme.fg("text", INCOMING)} ${theme.fg("text", clean(envelope.from))}`;
  if (envelope.replyTo) {
    header += theme.fg(
      "dim",
      `${SEPARATOR}reply: hc send ${clean(envelope.replyTo)}`,
    );
  }
  const container = new Container();
  container.addChild(row(theme, outputPad, header));
  container.addChild(
    row(
      theme,
      outputPad + BODY_INDENT,
      theme.fg("text", clean(envelope.body).trim()),
    ),
  );
  return container;
}

/**
 * Draws Herdr input as compact, ink-only rows: a note is one line with the
 * incoming marker, the child's address and name in the text colour and the
 * rest muted; a message names its sender above the indented text. Neither
 * uses the user's quote bar nor plain assistant prose. Notes in one batch
 * stack without blank lines between them.
 */
export const renderHerdrMessage: MessageRenderer = (
  message,
  options,
  theme,
) => {
  if (typeof message.content !== "string") return undefined;
  const envelopes = parseHerdrInput(message.content);
  // Pi falls back to its default custom-message rendering.
  if (!envelopes) return undefined;
  const container = new Container();
  for (const envelope of envelopes) {
    container.addChild(
      envelope.kind === "note"
        ? renderNote(envelope, options, theme)
        : renderMessage(envelope, options, theme),
    );
  }
  return container;
};
