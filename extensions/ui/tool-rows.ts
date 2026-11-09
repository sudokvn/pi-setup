import type {
  Theme,
  ToolRendererResolver,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
  Text,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";

type RenderCall = NonNullable<ToolRenderers["renderCall"]>;
type RenderResult = NonNullable<ToolRenderers["renderResult"]>;
type RenderContext = Parameters<RenderCall>[2];
export type ToolResult = Parameters<RenderResult>[0];

/** Tool-specific additions to a collapsed row. */
export interface RowSummary {
  /** Shown between the label and the status, for example "5 calls". */
  readonly detail?: string;
  /** Shown after the status and duration, for example a cost or an error. */
  readonly trailer?: string;
}

export interface ToolRowSpec {
  /** Replaces the first line of the tool's own call rendering. */
  readonly label?: (theme: Theme) => string;
  readonly summarize?: (result: ToolResult, theme: Theme) => RowSummary;
}

interface RowState {
  innerCall?: Component;
  innerResult?: Component;
  summary?: RowSummary;
  /** When this module first drew the row running, for its elapsed-time counter. */
  startedAt?: number;
  ticker?: ReturnType<typeof setInterval>;
}

/**
 * Pi keeps one state object per tool row and passes it to both renderers. Keying
 * by it keeps this module's state out of the tool's own renderer state.
 */
const rows = new WeakMap<object, RowState>();

function rowState(context: RenderContext): RowState {
  const key: object = context.state;
  let state = rows.get(key);
  if (!state) {
    state = {};
    rows.set(key, state);
  }
  return state;
}

const SEPARATOR = " · ";
const MAX_TRAILER_SHARE = 0.4;
const MAX_DETAIL_SHARE = 0.5;

function formatDuration(ms: number) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Errors end with their summary, such as bash's "Command exited with code 1". */
function lastTextLine(result: ToolResult): string | undefined {
  return result.content
    .flatMap((block) => (block.type === "text" ? block.text.split("\n") : []))
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

/**
 * Fullscreen mode's "auto" scrollbar is drawn over the last column while
 * scrolling. Truncated rows leave it free so their status stays visible.
 */
const SCROLLBAR_GUTTER = 1;

/** Wide enough that a call line is not wrapped before the row truncates it. */
const UNWRAPPED_WIDTH = 1000;

/** The line without the padding components add up to their render width. */
function trimLineEnd(line: string) {
  const width = visibleWidth(stripTerminalSequences(line).trimEnd());
  return truncateToWidth(line, width, "");
}

/** First non-blank line, without trailing padding. */
function firstVisibleLine(component: Component) {
  for (const line of component.render(UNWRAPPED_WIDTH)) {
    const width = visibleWidth(stripTerminalSequences(line).trimEnd());
    if (width > 0) return truncateToWidth(line, width, "");
  }
  return undefined;
}

/** Padding lines carry colour sequences, so emptiness is checked on the text. */
function isBlank(line: string | undefined) {
  return line === undefined || !stripTerminalSequences(line).trim();
}

function dropBlankEdges(lines: string[]) {
  while (lines.length > 0 && isBlank(lines[0])) lines.shift();
  while (lines.length > 0 && isBlank(lines.at(-1))) lines.pop();
  return lines;
}

/** Colors and text attributes; OSC 8 links stay clickable. */
const SGR = /\x1b\[[0-9;:]*m/g;

/**
 * Collapsed rows drop the tool's own styling and use one color: accent while
 * running, muted when done, so finished work recedes behind the agent's
 * messages.
 */
function recolor(theme: Theme, color: "accent" | "muted", label: string) {
  return theme.fg(color, label.replace(SGR, ""));
}

/** Pi's own spinner frames and speed, matching its Working indicator. */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 80;

/**
 * Redraws a running row for its spinner and timer. Pi creates a new call
 * component on every update and never disposes the old one, so the timer
 * lives in the row state and stops once the row finishes or expands.
 */
function updateTicker(state: RowState, context: RenderContext) {
  if (!context.isPartial || context.expanded) {
    clearInterval(state.ticker);
    state.ticker = undefined;
    return;
  }
  state.startedAt ??= Date.now();
  if (!state.ticker) {
    state.ticker = setInterval(context.invalidate, FRAME_MS);
    // A row left running when Pi exits must not keep the process alive.
    state.ticker.unref();
  }
}

function statusMarker(theme: Theme, context: RenderContext, now: number) {
  if (context.isPartial) {
    const frame = SPINNER[Math.floor(now / FRAME_MS) % SPINNER.length];
    return theme.fg("accent", frame ?? "⠋");
  }
  return context.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
}

function timing(
  theme: Theme,
  context: RenderContext,
  state: RowState,
  now: number,
) {
  if (context.isPartial) {
    const seconds = Math.floor((now - (state.startedAt ?? now)) / 1000);
    return theme.fg("muted", `${seconds}s`);
  }
  return context.durationMs === undefined
    ? undefined
    : theme.fg("dim", formatDuration(context.durationMs));
}

/** Columns the expanded details sit in from the row's marker. */
const DETAIL_INDENT = 4;

/**
 * Pi marks the changed words of a one-line replacement in inverse video, a
 * filled block (diff.js hardcodes theme.inverse). Underline says the same
 * without a block. Only SGR 7/27 are touched; colours stay as they are.
 */
// eslint-disable-next-line no-control-regex
const INVERSE_ON = /\x1b\[7m/g;
// eslint-disable-next-line no-control-regex
const INVERSE_OFF = /\x1b\[27m/g;

function underlineInsteadOfInverse(line: string) {
  return line.replace(INVERSE_ON, "\x1b[4m").replace(INVERSE_OFF, "\x1b[24m");
}

/**
 * An expanded row is the collapsed row with its details indented beneath it,
 * not a filled block: the status stays on the marker, so no background is
 * needed, and nothing on screen competes with the user's own message.
 */
function expandedCall(
  call: Component,
  theme: Theme,
  context: RenderContext,
  state: RowState,
): Component {
  return {
    render(width: number) {
      const now = Date.now();
      const pad = " ".repeat(context.outputPad);
      const indent = pad + " ".repeat(DETAIL_INDENT);
      const [first = "", ...rest] = dropBlankEdges(
        call.render(width - context.outputPad - DETAIL_INDENT),
      );
      const after = timing(theme, context, state, now);
      const head = `${statusMarker(theme, context, now)} ${trimLineEnd(first).trimStart()}`;
      return [
        pad + (after ? `${head}${theme.fg("dim", SEPARATOR)}${after}` : head),
        // Tools that frame themselves (edit, write) put a spacer before their body.
        ...dropBlankEdges(rest).map(
          (line) => indent + underlineInsteadOfInverse(line),
        ),
      ];
    },
    invalidate() {
      call.invalidate();
    },
  };
}

function expandedResult(result: Component, context: RenderContext): Component {
  const indent = " ".repeat(context.outputPad + DETAIL_INDENT);
  return {
    render(width: number) {
      // Pi's own result components start with a blank spacer line; the gap
      // between messages is Pi's, so none is added here either.
      return dropBlankEdges(result.render(width - indent.length)).map((line) =>
        isBlank(line) ? "" : indent + underlineInsteadOfInverse(line),
      );
    },
    invalidate() {
      result.invalidate();
    },
  };
}

/** Pi's fallback for tools without a call renderer: the name and its arguments. */
function fallbackCall(
  toolName: string,
  args: unknown,
  theme: Theme,
  expanded: boolean,
) {
  const title = theme.fg("toolTitle", theme.bold(toolName));
  const entries =
    typeof args === "object" && args !== null && !Array.isArray(args)
      ? Object.entries(args)
      : args === undefined
        ? []
        : [["args", args] as const];
  const json = (value: unknown, indent?: number) =>
    JSON.stringify(value, null, indent) ?? String(value);
  const text = expanded
    ? entries.map(
        ([key, value]) =>
          `\n  ${key}: ${typeof value === "string" ? value : json(value, 2)}`,
      )
    : entries.map(([key, value]) => ` ${key}=${json(value)}`);
  return new Text(title + theme.fg("muted", text.join("")), 0, 0);
}

function fallbackResult(result: ToolResult, theme: Theme) {
  const text = result.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
  return new Text(theme.fg("toolOutput", text), 0, 0);
}

/**
 * Collapse every tool row to one line: the tool's own call summary, status,
 * duration and, on failure, the first error line. Ctrl+O or a click on the row
 * shows the tool's full rendering.
 */
export function compactToolRows(
  specs: Readonly<Record<string, ToolRowSpec>> = {},
): ToolRendererResolver {
  return (toolName, next) => {
    const builtIn = next();
    const spec = specs[toolName];

    const innerCall: RenderCall = (args, theme, context) => {
      const state = rowState(context);
      const component = builtIn?.renderCall
        ? builtIn.renderCall(args, theme, {
            ...context,
            lastComponent: state.innerCall,
          })
        : fallbackCall(toolName, args, theme, context.expanded);
      state.innerCall = component;
      return component;
    };

    return {
      ...builtIn,
      renderShell: "self",
      renderCall(args, theme, context) {
        const state = rowState(context);
        updateTicker(state, context);
        if (context.expanded) {
          // The indent replaces the padding self-framing tools would apply.
          const call = innerCall(args, theme, { ...context, outputPad: 0 });
          return expandedCall(call, theme, context, state);
        }

        const call = spec?.label ? undefined : innerCall(args, theme, context);
        return {
          render(width: number) {
            const now = Date.now();
            const pad = " ".repeat(context.outputPad);
            const available = Math.max(
              1,
              width - context.outputPad - SCROLLBAR_GUTTER,
            );
            const { trailer } = state.summary ?? {};
            const separator = theme.fg("dim", SEPARATOR);
            const marker = `${statusMarker(theme, context, now)} `;
            const label = recolor(
              theme,
              context.isPartial ? "accent" : "muted",
              spec?.label?.(theme) ??
                (call && firstVisibleLine(call)) ??
                toolName,
            );
            // A long error may take at most this share of the row; the end of
            // the row is cut instead of the tool's own label.
            const trailerOverflow = trailer
              ? Math.max(
                  0,
                  visibleWidth(trailer) -
                    Math.floor(available * MAX_TRAILER_SHARE),
                )
              : 0;
            const after = [timing(theme, context, state, now), trailer].filter(
              Boolean,
            );
            // A long detail, such as a written answer, uses the space the
            // label leaves free, and at least this share of the row. It is cut
            // itself so the timing after it stays visible.
            const detail =
              state.summary?.detail &&
              truncateToWidth(
                state.summary.detail,
                Math.max(
                  Math.floor(available * MAX_DETAIL_SHARE),
                  available -
                    visibleWidth(marker) -
                    visibleWidth(label) -
                    visibleWidth(SEPARATOR) * (after.length + 1) -
                    visibleWidth(after.join("")) +
                    trailerOverflow,
                ),
                theme.fg("dim", "…"),
              );
            const suffix = [detail, ...after].filter(Boolean).join(separator);
            const labelWidth = Math.max(
              Math.min(12, available),
              available -
                visibleWidth(marker) -
                (suffix
                  ? visibleWidth(SEPARATOR) +
                    visibleWidth(suffix) -
                    trailerOverflow
                  : 0),
            );
            const line =
              marker +
              truncateToWidth(label, labelWidth, theme.fg("dim", "…")) +
              (suffix ? separator + suffix : "");
            return [
              pad + truncateToWidth(line, available, theme.fg("dim", "…")),
            ];
          },
          invalidate() {
            call?.invalidate();
          },
        };
      },
      renderResult(result, options, theme, context) {
        const state = rowState(context);
        if (options.expanded) {
          const component = builtIn?.renderResult
            ? builtIn.renderResult(result, options, theme, {
                ...context,
                outputPad: 0,
                lastComponent: state.innerResult,
              })
            : fallbackResult(result, theme);
          state.innerResult = component;
          return expandedResult(component, context);
        }

        const summary = spec?.summarize?.(result, theme) ?? {};
        const error =
          context.isError && !options.isPartial
            ? lastTextLine(result)
            : undefined;
        state.summary = error
          ? {
              ...summary,
              trailer: [summary.trailer, theme.fg("error", error)]
                .filter(Boolean)
                .join(theme.fg("dim", SEPARATOR)),
            }
          : summary;
        // The call line draws the whole row.
        return { render: () => [], invalidate() {} };
      },
    };
  };
}
