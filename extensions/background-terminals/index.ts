/**
 * Background terminals — start long-running shell processes the model can
 * inspect and stop, but never write to (stdin is ignored at the OS level).
 *
 * Tools (for the LLM):
 * - bg-start: fire-and-forget spawn (command, title, working_dir). Max 8
 *   running at once.
 * - bg-status: peek at one terminal's status + tail-truncated output.
 * - bg-wait: block until all/any listed terminals exit (optional timeout)
 *   and return their results.
 * - bg-list: list all tracked terminals (running and settled).
 * - bg-kill: SIGTERM→SIGKILL the whole process tree; returns final state.
 *
 * Results are pull-only: an exit never writes into the conversation or starts
 * a turn. A one-line widget above the editor counts running terminals and
 * exit results the model has not collected with bg-wait, bg-status or
 * bg-kill; `c`/`C` in /ps clear them. `/ps` opens a two-stage full-screen
 * overlay (list → read-only detail with stdout/stderr toggle).
 *
 * Architecture: Effect v4 core (manager service behind one ManagedRuntime);
 * this file is the async boundary where tool handlers run effects via
 * runTool. Node stream plumbing inside the manager is plain callbacks.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { stringEnum } from "../shared/schema.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  getMarkdownTheme,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { Key, Markdown, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { TerminalManager, type TerminalManagerShape } from "./src/manager.ts";
import {
  BG_KILL_PARAMETER_DESCRIPTIONS,
  BG_KILL_TOOL_DESCRIPTION,
  BG_LIST_TOOL_DESCRIPTION,
  BG_START_PARAMETER_DESCRIPTIONS,
  BG_START_PROMPT_GUIDELINES,
  BG_START_PROMPT_SNIPPET,
  BG_START_TOOL_DESCRIPTION,
  BG_STATUS_PARAMETER_DESCRIPTIONS,
  BG_STATUS_TOOL_DESCRIPTION,
  BG_WAIT_PARAMETER_DESCRIPTIONS,
  BG_WAIT_TOOL_DESCRIPTION,
  buildKillReport,
  buildStartResult,
  buildStatusResult,
  buildWaitResult,
  describeTerminal,
  longBashBlockReason,
} from "./src/prompt.ts";
import {
  createTerminalRuntime,
  runTool,
  type TerminalRuntime,
} from "./src/runtime.ts";
import { sanitizeText } from "./src/ui/output-view.ts";
import { openTerminalPicker } from "./src/ui/ps.ts";

const WIDGET_KEY = "background-terminals";

function formatWidget(
  theme: Theme,
  counts: { running: number; ready: number; failed: number },
) {
  const parts = [
    counts.running > 0 && theme.fg("warning", `■ ${counts.running} running`),
    counts.ready > 0 && theme.fg("success", `■ ${counts.ready} ready`),
    counts.failed > 0 && theme.fg("error", `■ ${counts.failed} failed`),
  ].filter((part) => part !== false);
  return (
    theme.fg("text", "background terminals: ") +
    parts.join(theme.fg("dim", " · ")) +
    theme.fg("dim", " • ") +
    theme.fg("accent", "/ps") +
    theme.fg("dim", " to view")
  );
}

export default function (pi: ExtensionAPI) {
  let runtime: TerminalRuntime | undefined;
  let managerPromise: Promise<TerminalManagerShape> | undefined;
  let ui: ExtensionUIContext | undefined;
  let unsubStatus: (() => void) | undefined;

  const getRuntime = () => (runtime ??= createTerminalRuntime());

  /** Resolve the manager service once per runtime and wire the extension hooks. */
  const getManager = () => {
    managerPromise ??= getRuntime()
      .runPromise(TerminalManager)
      .then((manager) => {
        unsubStatus?.();
        unsubStatus = manager.view.subscribe(() => updateWidget(manager));
        updateWidget(manager);
        return manager;
      });
    return managerPromise;
  };

  /** One-line widget directly above the editor while terminals run or exit
   * results await collection. Called on every manager notification
   * (including per-output-chunk), so it only touches setWidget when the
   * counts actually change — replacing the widget factory hundreds of times
   * a second would churn component creation for no visible difference. */
  let widgetKey = "";
  const updateWidget = (manager: TerminalManagerShape) => {
    if (!ui) return;
    try {
      const terminals = manager.view.list();
      const running = terminals.filter(
        (snap) => snap.status === "running",
      ).length;
      const awaiting = terminals.filter(
        (snap) => snap.status !== "running" && !snap.collected,
      );
      const failed = awaiting.filter((snap) => snap.status === "failed").length;
      const ready = awaiting.length - failed;
      const key = `${running}/${ready}/${failed}`;
      if (key === widgetKey) return;
      widgetKey = key;
      if (running + ready + failed === 0) {
        ui.setWidget(WIDGET_KEY, undefined);
        return;
      }
      ui.setWidget(WIDGET_KEY, (_tui, theme) => {
        const line = formatWidget(theme, { running, ready, failed });
        return { render: () => [line], invalidate: () => {} };
      });
    } catch {
      // UI may be unavailable (print/RPC modes or teardown).
    }
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) ui = ctx.ui;
  });

  // /new, /resume, /fork, /reload, and quit all emit session_shutdown for
  // the old extension instance. Processes never survive a session
  // transition: disposing the runtime runs the manager finalizer →
  // disposeAll → every entry scope → SIGTERM→SIGKILL tree kill, each close
  // bounded so a wedged process cannot hang shutdown.
  pi.on("session_shutdown", async () => {
    unsubStatus?.();
    unsubStatus = undefined;
    try {
      ui?.setWidget(WIDGET_KEY, undefined);
    } catch {
      // UI may already be gone.
    }
    widgetKey = "";
    ui = undefined;
    const closing = runtime;
    runtime = undefined;
    managerPromise = undefined;
    await closing?.dispose();
  });

  // Prompt guidance alone does not stop the model from parking the session
  // on a long blocking wait, so reject over-long bash timeouts outright.
  pi.on("tool_call", (event) => {
    if (!isToolCallEventType("bash", event)) return;
    const reason = longBashBlockReason(event.input.timeout);
    if (reason) return { block: true, reason };
  });

  // --- Tools -------------------------------------------------------------

  pi.registerTool({
    name: "bg-start",
    label: "Start Background Terminal",
    description: BG_START_TOOL_DESCRIPTION,
    promptSnippet: BG_START_PROMPT_SNIPPET,
    promptGuidelines: BG_START_PROMPT_GUIDELINES,
    parameters: Type.Object({
      command: Type.String({
        description: BG_START_PARAMETER_DESCRIPTIONS.command,
      }),
      title: Type.String({
        description: BG_START_PARAMETER_DESCRIPTIONS.title,
      }),
      working_dir: Type.Optional(
        Type.String({
          description: BG_START_PARAMETER_DESCRIPTIONS.workingDir,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const manager = await getManager();

      const command = params.command.trim();
      if (!command) throw new Error("command must not be empty.");

      const cwd = path.resolve(ctx.cwd, params.working_dir ?? ".");
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        throw new Error(`working_dir is not a directory: ${cwd}`);
      }

      // Collapse whitespace (a newline inside a one-line UI row desyncs the
      // TUI renderer) before bounding the length.
      const title =
        params.title.replace(/\s+/g, " ").trim().slice(0, 80) || "terminal";
      const snap = await runTool(
        getRuntime(),
        manager.start({ command, title, cwd }),
      );

      return {
        content: [{ type: "text", text: buildStartResult(snap) }],
        details: { id: snap.id, title: snap.title, cwd, pid: snap.pid },
      };
    },
  });

  pi.registerTool({
    name: "bg-status",
    label: "Check Background Terminal",
    description: BG_STATUS_TOOL_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({ description: BG_STATUS_PARAMETER_DESCRIPTIONS.id }),
    }),
    async execute(_toolCallId, params) {
      const manager = await getManager();
      const snap = manager.view.get(params.id);
      if (!snap) {
        const known = manager.view.list().map((s) => s.id);
        throw new Error(
          `Unknown terminal id "${params.id}". Known: ${known.join(", ") || "none"}.`,
        );
      }

      // Returning a settled terminal's final state collects it.
      manager.view.collect([snap.id]);

      return {
        content: [{ type: "text", text: buildStatusResult(snap) }],
        details: {
          id: snap.id,
          status: snap.status,
          pid: snap.pid,
          exitCode: snap.exitCode,
          signal: snap.signal,
        },
      };
    },
  });

  pi.registerTool({
    name: "bg-wait",
    label: "Wait for Background Terminals",
    description: BG_WAIT_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        minItems: 1,
        maxItems: 64,
        description: BG_WAIT_PARAMETER_DESCRIPTIONS.ids,
      }),
      mode: Type.Optional(
        stringEnum(["all", "any"] as const, {
          description: BG_WAIT_PARAMETER_DESCRIPTIONS.mode,
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 2_147_483_647,
          description: BG_WAIT_PARAMETER_DESCRIPTIONS.timeoutMs,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const manager = await getManager();
      const ids = [...new Set(params.ids)];
      const unknown = ids.filter((id) => !manager.view.get(id));
      if (unknown.length > 0) {
        const known = manager.view.list().map((snap) => snap.id);
        throw new Error(
          `Unknown terminal id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
        );
      }

      const running = ids.filter(
        (id) => manager.view.get(id)?.status === "running",
      );
      if (running.length > 0) {
        onUpdate?.({
          content: [
            { type: "text", text: `Waiting for ${running.join(", ")}...` },
          ],
          details: { pending: running },
        });
      }

      const mode = params.mode ?? "all";
      const result = await runTool(
        getRuntime(),
        manager.wait(ids, mode, params.timeoutMs),
        { signal, interruptMessage: "Wait aborted. Terminals keep running." },
      );

      manager.view.collect(result.settled.map((snap) => snap.id));

      return {
        content: [{ type: "text", text: buildWaitResult(result) }],
        details: {
          mode,
          timedOut: result.timedOut,
          pending: result.pending,
          results: result.settled.map((snap) => ({
            id: snap.id,
            title: snap.title,
            status: snap.status,
            exitCode: snap.exitCode,
            signal: snap.signal,
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: "bg-list",
    label: "List Background Terminals",
    description: BG_LIST_TOOL_DESCRIPTION,
    parameters: Type.Object({}),
    async execute() {
      const manager = await getManager();
      const terminals = manager.view.list();
      const text =
        terminals.length === 0
          ? "No background terminals."
          : terminals.map((snap) => describeTerminal(snap)).join("\n");
      return {
        content: [{ type: "text", text }],
        details: {
          terminals: terminals.map((snap) => ({
            id: snap.id,
            title: snap.title,
            status: snap.status,
            pid: snap.pid,
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: "bg-kill",
    label: "Kill Background Terminals",
    description: BG_KILL_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        description: BG_KILL_PARAMETER_DESCRIPTIONS.ids,
      }),
    }),
    async execute(_toolCallId, params, signal) {
      const manager = await getManager();
      const ids = [...new Set(params.ids)];
      if (ids.length === 0)
        throw new Error("Provide at least one terminal id.");

      const known = manager.view.list().map((snap) => snap.id);
      const unknown = ids.filter((id) => !manager.view.get(id));
      if (unknown.length > 0) {
        throw new Error(
          `Unknown terminal id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
        );
      }

      const report = await runTool(getRuntime(), manager.kill(ids), {
        signal,
        interruptMessage:
          "Kill wait aborted; termination continues in the background.",
      });

      // The report returns each terminal's final state, including ones that
      // settled before this kill began.
      manager.view.collect(ids);

      return {
        content: [{ type: "text", text: buildKillReport(report) }],
        details: {
          results: report.map((entry) => ({
            id: entry.id,
            title: entry.title,
            status: entry.status,
            killed: entry.killed,
          })),
        },
      };
    },
  });

  // --- Result message rendering ------------------------------------------

  // Earlier releases pushed exit results as custom messages; keep rendering
  // them in existing sessions.

  pi.registerMessageRenderer(
    "background-terminal-result",
    (message, { expanded }, theme) => {
      const details = (message.details ?? {}) as {
        id?: string;
        title?: string;
        status?: string;
        exitCode?: number;
        signal?: string;
      };
      const failed = details.status === "failed";
      const killed = details.status === "killed";
      const icon = failed
        ? theme.fg("error", "x")
        : killed
          ? theme.fg("muted", "■")
          : theme.fg("success", "■");
      const how = killed
        ? "killed"
        : (details.signal ?? `exit ${details.exitCode ?? "?"}`);
      const header =
        `${icon} ` +
        theme.fg(
          "muted",
          `terminal ${details.id ?? "?"} · ${details.title ?? ""} · ${how}`,
        );

      const content =
        typeof message.content === "string" ? message.content : "";
      // Remove only the summary line; the Error line (when present) is part
      // of the actual result and must remain visible. The body carries raw
      // process output — sanitize ANSI/control chars or the transcript smears.
      const body = sanitizeText(content.split("\n").slice(1).join("\n").trim());

      if (expanded) {
        const md = new Markdown(`${body}`, 0, 0, getMarkdownTheme());
        const container = new Text(header, 0, 0);
        return {
          render: (width: number) => [
            ...container.render(width),
            ...md.render(width),
          ],
          invalidate: () => {
            container.invalidate();
            md.invalidate();
          },
        };
      }

      // Collapsed results match the one-line tool rows; Ctrl+O shows the output.
      return {
        render: (width: number) => [truncateToWidth(header, width)],
        invalidate() {},
      };
    },
  );

  // --- Command ------------------------------------------------------------

  const openDashboard = async (ctx: ExtensionContext) => {
    const manager = await getManager();
    if (ctx.mode !== "tui") {
      if (ctx.hasUI) {
        const terminals = manager.view.list();
        ctx.ui.notify(
          terminals.length === 0
            ? "No background terminals."
            : terminals.map((snap) => describeTerminal(snap)).join("\n"),
          "info",
        );
      }
      return;
    }
    if (manager.view.size() === 0) {
      ctx.ui.notify(
        "No background terminals yet. The agent starts them with bg-start.",
        "info",
      );
      return;
    }
    await openTerminalPicker(ctx, manager.view);
  };

  pi.registerCommand("ps", {
    description: "List and inspect background terminals",
    handler: (_args, ctx) => openDashboard(ctx),
  });

  pi.registerShortcut(Key.ctrlShift("b"), {
    description: "Open the background terminals panel",
    handler: openDashboard,
  });
}
