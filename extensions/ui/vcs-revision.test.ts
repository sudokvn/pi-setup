import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { jjNameRoot, parseJjRevision } from "./vcs/vcs.ts";

test("the change ID keeps its unique prefix apart from the rest", () => {
  assert.deepEqual(parseJjRevision("n\0orxulrz\0"), {
    changeId: { prefix: "n", rest: "orxulrz" },
    bookmarks: [],
  });
  // A prefix as long as the whole ID leaves the rest empty.
  assert.deepEqual(parseJjRevision("tzqolmry\0\0main\0release"), {
    changeId: { prefix: "tzqolmry", rest: "" },
    bookmarks: ["main", "release"],
  });
});

test("a workspace in a folder named after its repository is named from that folder", (t) => {
  const base = mkdtempSync(join(tmpdir(), "pi-vcs-name-root-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const main = join(base, "kumio");
  mkdirSync(join(main, ".jj", "repo"), { recursive: true });

  /** A secondary workspace: `.jj/repo` is a file pointing at the main repository. */
  const workspace = (...folders: string[]) => {
    const root = join(base, ...folders);
    mkdirSync(join(root, ".jj"), { recursive: true });
    writeFileSync(
      join(root, ".jj", "repo"),
      `${"../".repeat(folders.length + 1)}kumio/.jj/repo`,
    );
    return root;
  };

  assert.equal(jjNameRoot(main), main);
  assert.equal(
    jjNameRoot(workspace(".workspaces", "kumio", "invoices")),
    join(base, ".workspaces", "kumio"),
  );
  const elsewhere = workspace("scratch", "invoices");
  assert.equal(jjNameRoot(elsewhere), elsewhere);
});
