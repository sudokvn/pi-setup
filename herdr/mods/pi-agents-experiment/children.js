// Core terminals and Pi's in-process runs share a tree, but only terminals
// have an address that Herdr can focus or peek into.
const RECORD_ID = /^pi-subagents\/[A-Za-z0-9_.+-]{1,32}$/;
const STATES = new Set(["working", "done", "error", "idle", "blocked"]);

export function childEntries(all, address, lead = []) {
  const parent = all.find((terminal) => terminal.address === address);
  const terminals = all
    .filter(
      (terminal) => terminal.parent === address && terminal.state === "live",
    )
    .map((t) => ({ t }));
  const records = Object.entries(
    parent?.state === "live" ? (parent.records ?? {}) : {},
  )
    .filter(([id, record]) => RECORD_ID.test(id) && STATES.has(record?.state))
    .map(([id, record]) => ({
      parent: address,
      record: { id, name: record.title || "subagent", state: record.state },
    }))
    .sort(
      (a, b) =>
        a.record.name.localeCompare(b.record.name) ||
        a.record.id.localeCompare(b.record.id),
    );
  const children = [...terminals, ...records];
  return children.flatMap((entry, index) => {
    const last = index === children.length - 1;
    const row = { ...entry, lines: [...lead, last ? "└" : "├"] };
    return entry.t
      ? [row, ...childEntries(all, entry.t.address, [...lead, last ? "" : "│"])]
      : [row];
  });
}

export function childStatus(entry, listed) {
  if (entry.record) {
    return entry.record.state === "error" ? "blocked" : entry.record.state;
  }
  const state = listed.get(entry.t.address) ?? entry.t.status;
  // Keep Herdr's native child-terminal semantics: their parent's completion
  // is the news. Pi's uncollected status records keep their own done state.
  return state === "error" ? "blocked" : state === "done" ? "idle" : state;
}
