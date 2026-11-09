import assert from "node:assert/strict";
import test from "node:test";
import { parseHerdrInput } from "./envelope.ts";

// Verbatim outputs of upstream's own `note()` tests (herdr-core notes.rs).
const BLOCKED = "<hc>t1 reviewer is blocked (permission). See: hc read t1</hc>";
const ERROR =
  "<hc>t1 reviewer hit an error: rate limited. See: hc read t1</hc>";
const REMOTE_EXIT =
  "<hc>rohan/t1 reviewer exited (exit 3). Read: hc read rohan/t1</hc>";
const LAST_LINES =
  "<hc>t1 reviewer exited (exit 3). Last lines:\na\nb[201~\tc\nRead: hc read t1</hc>";

test("recognizes each note shape upstream produces", () => {
  for (const note of [BLOCKED, ERROR, REMOTE_EXIT, LAST_LINES]) {
    const parsed = parseHerdrInput(note);
    assert.equal(parsed?.length, 1, note);
    assert.equal(parsed[0]!.kind, "note");
  }
  assert.deepEqual(parseHerdrInput(REMOTE_EXIT), [
    {
      kind: "note",
      address: "rohan/t1",
      body: "rohan/t1 reviewer exited (exit 3). Read: hc read rohan/t1",
    },
  ]);
});

test("splits a newline-joined batch, including multi-line notes", () => {
  const parsed = parseHerdrInput(
    [
      BLOCKED,
      LAST_LINES,
      "<hc>t9z exited (signal 9). Read: hc read t9z</hc>",
    ].join("\n"),
  );
  assert.deepEqual(
    parsed?.map((envelope) => envelope.kind === "note" && envelope.address),
    ["t1", "t1", "t9z"],
  );
});

test("recognizes tagged messages with sender, name and reply address", () => {
  assert.deepEqual(
    parseHerdrInput('<hc from="t7 review">Two bugs in x.rs</hc>'),
    [{ kind: "message", from: "t7 review", body: "Two bugs in x.rs" }],
  );
  assert.deepEqual(
    parseHerdrInput(
      '<hc from="t3 lead" reach="hc send t3 when done or stuck">Review x.rs\n\nThen report.</hc>',
    ),
    [
      {
        kind: "message",
        from: "t3 lead",
        replyTo: "t3",
        body: "Review x.rs\n\nThen report.",
      },
    ],
  );
  assert.deepEqual(parseHerdrInput('<hc from="rohan/t7">done</hc>'), [
    { kind: "message", from: "rohan/t7", body: "done" },
  ]);
});

test("leaves ordinary, mixed, ambiguous and unfamiliar input alone", () => {
  for (const input of [
    "fix the loader",
    `please look at this:\n${BLOCKED}`,
    `${BLOCKED}\nand then summarize`,
    `\`\`\`\n${BLOCKED}\n\`\`\``,
    // The user's words between two messages must not join them into one.
    '<hc from="t7">first</hc>\nuser speaking here\n<hc from="t8">second</hc>',
    `${BLOCKED}${BLOCKED}`, // upstream separates envelopes with newlines
    `${BLOCKED} ${BLOCKED}`,
    // Payloads are not escaped upstream; literal tags make input ambiguous.
    '<hc from="t7">see <hc>t3 exited. Read: hc read t3</hc> above</hc>',
    '<hc from="t7">a stray </HC> tag</hc>',
    "<hc>t1 exited (exit 1). Last lines:\n</hc>\nRead: hc read t1</hc>",
    "<hc>hello</hc>",
    "<hc>t1 . See: hc read t1</hc>", // says nothing about the child
    "<hc>t1 exited. Read: hc read t2</hc>", // points at another terminal
    '<hc from="t7" to="t3">hi</hc>', // unknown attribute
    '<hc from="t7" reach="hc send t8 when done or stuck">hi</hc>', // reply elsewhere
    '<hc from="t7 \u001b[31mred">hi</hc>', // control characters in the sender
    '<hc from="kevin">hi</hc>', // not an address
    '<hc from="t7">   </hc>',
    '<hc from="t7">unterminated',
    "<HC>t1 exited. Read: hc read t1</HC>",
  ]) {
    assert.equal(parseHerdrInput(input), undefined, input);
  }
});
