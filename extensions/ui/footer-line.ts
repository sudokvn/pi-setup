import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  getCapabilities,
  hyperlink,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { ActivityCounts, ActivitySource } from "../shared/activity.ts";
import { countMarker } from "../shared/markers.ts";
import type { VcsInfoState } from "./vcs/state.ts";

// Nerd Font glyphs. Each occupies one cell but is drawn wider than that, so
// two spaces follow it.
const ICON = {
  terminals: "\uF120",
  subagents: "\u{F06A9}",
  bookmark: "\uF02E",
} as const;

/** Narrow panes shorten the change ID to this length, or to its unique prefix if that is longer. */
const SHORT_CHANGE_ID = 4;
/** The two groups never touch, even in the narrowest pane. */
const GROUP_SEPARATION = 2;

export interface FooterState {
  cwd: string;
  home: string;
  vcs: VcsInfoState;
  /** Status text other extensions set through `ctx.ui.setStatus()`. */
  statuses: readonly string[];
  activity: Record<ActivitySource, ActivityCounts>;
  modelId: string;
  /** `off` hides the thinking level. */
  thinking: string;
  contextPercent: number | null;
}

function displaySegments(path: string, home: string) {
  if (path === home) return ["~"];
  if (path.startsWith(`${home}/`)) {
    return ["~", ...path.slice(home.length + 1).split("/")];
  }
  return path.split("/");
}

/**
 * Splits the working directory into the folders above the repository and the
 * name that identifies it: the repository folder and anything below it, or
 * the last folder outside a repository.
 */
export function splitDirectory(
  cwd: string,
  home: string,
  nameRoot: string | null,
) {
  const segments = displaySegments(cwd, home);
  const inside =
    nameRoot !== null && (cwd === nameRoot || cwd.startsWith(`${nameRoot}/`));
  const start = inside
    ? displaySegments(nameRoot, home).length - 1
    : segments.length - 1;
  return {
    parents: segments.slice(0, start),
    name: segments.slice(start).join("/"),
  };
}

/** `Projects` becomes `P`; a dot folder keeps its dot: `.workspaces` becomes `.w`. */
function abbreviate(segment: string) {
  const [first = "", second = ""] = segment;
  return first === "." ? first + second : first;
}

function canAbbreviate(segment: string) {
  return segment !== "~" && abbreviate(segment) !== segment;
}

/** Abbreviates the first `count` parent folders that have something to give. */
function shortenParents(parents: readonly string[], count: number) {
  let remaining = count;
  return parents.map((segment) => {
    if (remaining === 0 || !canAbbreviate(segment)) return segment;
    remaining -= 1;
    return abbreviate(segment);
  });
}

interface Layout {
  gap: number;
  bookmarks: boolean;
  thinking: boolean;
  shortChangeId: boolean;
  shortParents: number;
  statuses: boolean;
  pullRequest: boolean;
  model: boolean;
  vcs: boolean;
}

/**
 * Layouts from widest to narrowest. Each gives up one more thing, and the
 * first that fits is used. The path, background work and context share are
 * never given up.
 */
function layouts(parentCount: number) {
  let layout: Layout = {
    gap: 3,
    bookmarks: true,
    thinking: true,
    shortChangeId: false,
    shortParents: 0,
    statuses: true,
    pullRequest: true,
    model: true,
    vcs: true,
  };
  const steps: Partial<Layout>[] = [
    { gap: 2 },
    { bookmarks: false },
    { thinking: false },
    { shortChangeId: true },
    ...Array.from({ length: parentCount }, (_, index) => ({
      shortParents: index + 1,
    })),
    { statuses: false },
    { pullRequest: false },
    { model: false },
    { vcs: false },
  ];
  return [layout, ...steps.map((step) => (layout = { ...layout, ...step }))];
}

function revision(theme: Theme, vcs: VcsInfoState, short: boolean) {
  const changed =
    vcs.changedFiles > 0 ? theme.fg("muted", ` ±${vcs.changedFiles}`) : "";
  // Git has no change ID: its branch takes that place.
  if (!vcs.changeId) {
    return theme.fg("muted", vcs.refs.join(",") || "@") + changed;
  }
  const { prefix, rest } = vcs.changeId;
  const shown = short
    ? rest.slice(0, Math.max(0, SHORT_CHANGE_ID - prefix.length))
    : rest;
  return (
    theme.fg("muted", "@ ") +
    // The unique prefix is the part to type, as in `jj log`.
    theme.fg("text", prefix) +
    theme.fg("muted", shown) +
    changed
  );
}

function pullRequest(theme: Theme, vcs: VcsInfoState) {
  if (!vcs.pullRequest) return "";
  const label = theme.fg("text", `#${vcs.pullRequest.number}`);
  return getCapabilities().hyperlinks
    ? hyperlink(label, vcs.pullRequest.url)
    : label;
}

function activity(theme: Theme, icon: string, counts: ActivityCounts) {
  const marks = [
    counts.running > 0 && countMarker(theme, "running", `${counts.running}`),
    counts.ready > 0 && countMarker(theme, "done", `${counts.ready}`),
    counts.failed > 0 && countMarker(theme, "failed", `${counts.failed}`),
    counts.cancelled > 0 &&
      countMarker(theme, "cancelled", `${counts.cancelled}`),
  ].filter((mark) => mark !== false);
  return marks.length > 0
    ? `${theme.fg("muted", icon)}  ${marks.join(" ")}`
    : "";
}

function contextShare(theme: Theme, percent: number | null) {
  if (percent === null) return "";
  const rounded = Math.round(percent);
  const color = rounded >= 90 ? "error" : rounded >= 70 ? "warning" : "muted";
  return theme.fg(color, `${rounded}%`);
}

function compose(
  theme: Theme,
  state: FooterState,
  directory: ReturnType<typeof splitDirectory>,
  layout: Layout,
) {
  const { vcs } = state;
  const showVcs = layout.vcs && vcs.isRepository;
  const parents = shortenParents(directory.parents, layout.shortParents);
  const join = (parts: string[]) =>
    parts.filter(Boolean).join(" ".repeat(layout.gap));

  const left = join([
    (parents.length > 0 ? theme.fg("muted", `${parents.join("/")}/`) : "") +
      theme.fg("text", directory.name),
    showVcs ? revision(theme, vcs, layout.shortChangeId) : "",
    showVcs && layout.bookmarks && vcs.changeId && vcs.refs.length > 0
      ? theme.fg("muted", `${ICON.bookmark}  ${vcs.refs.join(",")}`)
      : "",
    showVcs && layout.pullRequest ? pullRequest(theme, vcs) : "",
    ...(layout.statuses
      ? state.statuses.map((status) => theme.fg("muted", status))
      : []),
  ]);

  const model =
    layout.model && state.modelId
      ? theme.fg("muted", state.modelId) +
        (layout.thinking && state.thinking !== "off"
          ? `  ${theme.fg("muted", state.thinking)}`
          : "")
      : "";
  // Background work sits left of the model, so it comes and goes without
  // moving the model or the context share.
  const right = join([
    activity(theme, ICON.terminals, state.activity.terminals),
    activity(theme, ICON.subagents, state.activity.subagents),
    model,
    contextShare(theme, state.contextPercent),
  ]);

  return { left, right };
}

function groupWidth(left: string, right: string) {
  return (
    visibleWidth(left) +
    visibleWidth(right) +
    (left && right ? GROUP_SEPARATION : 0)
  );
}

/** One footer line: location on the left, background work and model on the right. */
export function renderFooterLine(
  theme: Theme,
  state: FooterState,
  width: number,
) {
  const directory = splitDirectory(state.cwd, state.home, state.vcs.nameRoot);
  const candidates = layouts(directory.parents.filter(canAbbreviate).length);
  let line = { left: "", right: "" };
  for (const layout of candidates) {
    line = compose(theme, state, directory, layout);
    if (groupWidth(line.left, line.right) <= width) break;
  }

  // Narrower than the last layout: the path gives way before the right group.
  const room = width - visibleWidth(line.right) - GROUP_SEPARATION;
  const left =
    visibleWidth(line.left) <= room || !line.right
      ? line.left
      : room > 0
        ? truncateToWidth(line.left, room, theme.fg("dim", "…"))
        : "";
  const padding = width - visibleWidth(left) - visibleWidth(line.right);
  return truncateToWidth(
    `${left}${" ".repeat(Math.max(0, padding))}${line.right}`,
    width,
    "",
  );
}
