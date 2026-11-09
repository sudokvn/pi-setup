/**
 * Recognizes the text Herdr Core types into an agent's input.
 *
 * Upstream (`herdr-core/src/notes.rs`) produces two shapes:
 *
 * - a note about a child: `<hc>{address}{name} {what}. {See|Read}: hc read {address}</hc>`,
 *   where `. ` may instead be `. Last lines:\n…\n` with program output;
 * - a tagged message: `<hc from="{address}[ {name}]"[ reach="hc send {address} when done or stuck"]>{text}</hc>`.
 *
 * Several notes are joined with newlines into one typed batch.
 *
 * This is format recognition, not provenance: anyone can type these strings.
 * The parser only decides presentation, and it is deliberately strict. Input
 * must consist entirely of envelopes separated by newlines. Payloads are not
 * escaped upstream, so a body containing anything that looks like an `hc` tag
 * is ambiguous and the whole input stays an ordinary user message.
 */

/** A Herdr terminal address: `t7`, or `machine/t7` for another core. */
const ADDRESS = String.raw`(?:[A-Za-z0-9][A-Za-z0-9._-]*/)?t[1-9][0-9bcdfghjkmnpqrstvwxyz]*`;

// Sticky so each pattern matches exactly at the current position.
const NOTE_HEAD = new RegExp(String.raw`<hc>(${ADDRESS}) `, "y");
const MESSAGE_HEAD = new RegExp(
  // Template names are free-form upstream; quotes and control characters
  // are not accepted here.
  String.raw`<hc from="(${ADDRESS})(?: ([^"\u0000-\u001f\u007f-\u009f]+))?"(?: reach="hc send (${ADDRESS}) when done or stuck")?>`,
  "y",
);
const SEPARATOR = /[ \t]*(?:\r?\n[ \t]*)+/y;
const TAG_LIKE = /<\/?hc\b/i;
const CLOSE = "</hc>";

export type HerdrEnvelope =
  | {
      kind: "note";
      /** The child the note is about. */
      address: string;
      /** Text between the tags. */
      body: string;
    }
  | {
      kind: "message";
      /** Sender address and, when known, its name or template. */
      from: string;
      /** Where the sender asked for a reply, when it did. */
      replyTo?: string;
      body: string;
    };

/** A note body: says what happened, then where to look. */
function isNoteBody(body: string, address: string) {
  const match = /(?:\. |\n)(?:See|Read): hc read (\S+)$/.exec(body);
  // Something must stand between the address and the pointer.
  return match?.[1] === address && match.index > address.length + 1;
}

/** The envelope at `start` and where it ends, closing at the first `</hc>`. */
function envelopeAt(text: string, start: number) {
  let head: RegExpExecArray | null;
  let envelope: HerdrEnvelope;
  const close = (bodyStart: number) => {
    const end = text.indexOf(CLOSE, bodyStart);
    if (end === -1) return undefined;
    const body = text.slice(bodyStart, end);
    return TAG_LIKE.test(body) ? undefined : { body, end: end + CLOSE.length };
  };

  NOTE_HEAD.lastIndex = start;
  if ((head = NOTE_HEAD.exec(text))) {
    const address = head[1]!;
    const closed = close(start + "<hc>".length);
    if (!closed || !isNoteBody(closed.body, address)) return undefined;
    envelope = { kind: "note", address, body: closed.body };
    return { envelope, end: closed.end };
  }

  MESSAGE_HEAD.lastIndex = start;
  if ((head = MESSAGE_HEAD.exec(text))) {
    const [, address, name, replyTo] = head;
    // Upstream offers a reply to the sender itself; anything else is unknown.
    if (replyTo !== undefined && replyTo !== address) return undefined;
    const closed = close(MESSAGE_HEAD.lastIndex);
    if (!closed || closed.body.trim() === "") return undefined;
    envelope = {
      kind: "message",
      from: name === undefined ? address! : `${address} ${name}`,
      ...(replyTo === undefined ? {} : { replyTo }),
      body: closed.body,
    };
    return { envelope, end: closed.end };
  }
  return undefined;
}

/** Splits input made only of Herdr envelopes, or returns `undefined`. */
export function parseHerdrInput(text: string): HerdrEnvelope[] | undefined {
  const end = text.trimEnd().length;
  let position = text.length - text.trimStart().length;
  const envelopes: HerdrEnvelope[] = [];
  while (true) {
    const next = envelopeAt(text, position);
    if (!next || next.end > end) return undefined;
    envelopes.push(next.envelope);
    if (next.end === end) return envelopes;
    SEPARATOR.lastIndex = next.end;
    if (!SEPARATOR.test(text)) return undefined;
    position = SEPARATOR.lastIndex;
  }
}
