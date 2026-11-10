import type {
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

type BranchSource = Pick<
  ExtensionContext["sessionManager"],
  "getBranch" | "getLeafId"
>;

/**
 * Recorded usage cost of one branch entry, following Pi's session totals:
 * assistant responses, model-attributed usage entries such as cache warming,
 * tool results that report nested model usage, and summary generation.
 */
function entryCost(entry: SessionEntry) {
  switch (entry.type) {
    case "usage":
      return entry.usage.cost.total;
    case "compaction":
    case "branch_summary":
      return entry.usage?.cost.total ?? 0;
    case "message":
      if (entry.message.role === "assistant") {
        return entry.message.usage.cost.total;
      }
      if (entry.message.role === "toolResult") {
        return entry.message.usage?.cost.total ?? 0;
      }
      return 0;
    default:
      return 0;
  }
}

/**
 * Returns a reader for the current branch's recorded usage cost. Session entries are
 * immutable and every append moves the leaf, so the session and leaf identify
 * the branch exactly. Footer renders stay O(1) until something, such as a
 * background cache warm, appends usage.
 */
export function createBranchCostReader() {
  let cached:
    { source: BranchSource; leafId: string | null; cost: number } | undefined;
  return (source: BranchSource) => {
    const leafId = source.getLeafId();
    if (cached?.source === source && cached.leafId === leafId) {
      return cached.cost;
    }
    let cost = 0;
    for (const entry of source.getBranch()) cost += entryCost(entry);
    cached = { source, leafId, cost };
    return cost;
  };
}
