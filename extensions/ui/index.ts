import { homedir } from "node:os";
import { relative } from "node:path";
import {
  VERSION,
  type ExtensionAPI,
  type ExtensionContext,
  type ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
  NO_ACTIVITY,
  onActivity,
  type ActivityCounts,
  type ActivitySource,
} from "../shared/activity.ts";
import { REFRESH_CHANNEL } from "../shared/dashboard-state.ts";
import { askUserRow } from "./ask-user.ts";
import { codemodeRow } from "./codemode.ts";
import { compactToolRows } from "./tool-rows.ts";
import { renderFooterLine } from "./footer-line.ts";
import { markTranscriptRoles } from "./transcript.ts";
import { registerVcsInfo } from "./vcs/index.ts";
import { emptyVcsInfoState, type VcsInfoState } from "./vcs/state.ts";

interface ModelInfo {
  modelId: string;
  thinking: string;
  contextPercent: number | null;
}

// eslint-disable-next-line no-control-regex
const OSC_PATTERN =
  /(?:\u001b\]|\u009d)(?:[^\u0007\u001b\u009c]|\u001b(?!\\))*(?:\u0007|\u001b\\|\u009c)/g;
// eslint-disable-next-line no-control-regex
const CSI_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ESCAPE_PATTERN = /\u001b(?:[()][0-2A-Z]|[ -/]*[@-~])/g;

function sanitizeTerminalLabel(text: string) {
  return text
    .replace(OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(ESCAPE_PATTERN, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

function formatDirectory(cwd: string) {
  const home = homedir();
  if (cwd === home) return "~";
  const display = cwd.startsWith(`${home}/`) ? `~/${relative(home, cwd)}` : cwd;
  return sanitizeTerminalLabel(display);
}

function modelInfoEqual(left: ModelInfo, right: ModelInfo) {
  return (
    left.modelId === right.modelId &&
    left.thinking === right.thinking &&
    left.contextPercent === right.contextPercent
  );
}

type VcsRegistrar = (
  pi: ExtensionAPI,
  onStateChange: (state: VcsInfoState) => void,
) => void;

export default function ui(
  pi: ExtensionAPI,
  registerVcs: VcsRegistrar = registerVcsInfo,
) {
  let title = "pi";
  let modelInfo: ModelInfo = {
    modelId: "",
    thinking: "off",
    contextPercent: null,
  };
  let vcsInfo = emptyVcsInfoState();
  let activity: Record<ActivitySource, ActivityCounts> = {
    terminals: NO_ACTIVITY,
    subagents: NO_ACTIVITY,
  };
  let requestRender: (() => void) | undefined;

  // Sources publish on every change, including each chunk of terminal
  // output, so only a changed count redraws the footer.
  const stopActivityListener = onActivity(pi, (source, counts) => {
    const shown = activity[source];
    if (
      shown.running === counts.running &&
      shown.ready === counts.ready &&
      shown.failed === counts.failed &&
      shown.cancelled === counts.cancelled
    ) {
      return;
    }
    activity = { ...activity, [source]: counts };
    requestRender?.();
  });

  function refreshModelInfo(ctx: ExtensionContext) {
    const model = ctx.model;
    const usage = ctx.getContextUsage();
    const next: ModelInfo = {
      modelId: model?.id ?? "",
      thinking: model?.reasoning ? pi.getThinkingLevel() : "off",
      contextPercent: usage?.percent ?? null,
    };
    if (modelInfoEqual(modelInfo, next)) return;
    modelInfo = next;
    requestRender?.();
  }

  registerVcs(pi, (value: VcsInfoState) => {
    // Every refresh publishes a state built in the same place, so equal
    // states serialise identically.
    if (JSON.stringify(vcsInfo) === JSON.stringify(value)) return;
    vcsInfo = value;
    requestRender?.();
  });

  function install(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;

    ctx.ui.setHeader((tui, theme) => {
      requestRender = () => tui.requestRender();

      return {
        render(width: number) {
          const header = `${theme.fg("text", "▪ pi")} ${theme.fg("dim", `v${VERSION} · ${title}`)}`;
          return [truncateToWidth(header, width)];
        },
        invalidate() {},
      };
    });

    ctx.ui.setFooter((tui, theme, footerData: ReadonlyFooterDataProvider) => {
      requestRender = () => tui.requestRender();

      return {
        invalidate() {},
        render(width: number) {
          const statuses = Array.from(footerData.getExtensionStatuses())
            .sort(([a], [b]) => a.localeCompare(b))
            .flatMap(([, text]) => text.split("\n"))
            .map((line) => line.trim())
            .filter(Boolean);
          return [
            renderFooterLine(
              theme,
              {
                cwd: sanitizeTerminalLabel(ctx.cwd),
                home: homedir(),
                vcs: vcsInfo,
                statuses,
                activity,
                ...modelInfo,
              },
              width,
            ),
          ];
        },
      };
    });

    ctx.ui.setTitle(`pi · ${title}`);
    pi.events.emit(REFRESH_CHANNEL, undefined);
  }

  pi.registerMarkdownTransformer(markTranscriptRoles);
  pi.registerToolRenderer(
    compactToolRows({ codemode: codemodeRow, "ask-user": askUserRow }),
  );

  pi.on("session_start", (_event, ctx) => {
    title = formatDirectory(ctx.cwd);
    refreshModelInfo(ctx);
    install(ctx);
  });

  pi.on("model_select", (_event, ctx) => refreshModelInfo(ctx));
  pi.on("thinking_level_select", (_event, ctx) => refreshModelInfo(ctx));
  pi.on("agent_start", (_event, ctx) => refreshModelInfo(ctx));
  pi.on("turn_end", (_event, ctx) => refreshModelInfo(ctx));
  pi.on("agent_settled", (_event, ctx) => refreshModelInfo(ctx));

  pi.on("session_shutdown", (_event, ctx) => {
    stopActivityListener();
    requestRender = undefined;
    if (ctx.mode === "tui") {
      ctx.ui.setHeader(undefined);
      ctx.ui.setFooter(undefined);
    }
  });
}
