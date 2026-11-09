import type {
  CustomMessageEntryDraft,
  ExtensionAPI,
  ExtensionContext,
  SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";
import { parseHerdrInput } from "./envelope.ts";
import { INCOMING, renderHerdrMessage } from "./render.ts";

export const HERDR_MESSAGE = "herdr";

type Delivery = "steer" | "followUp";

interface Queued {
  text: string;
  deliverAs: Delivery;
}

const message = (text: string) => ({
  customType: HERDR_MESSAGE,
  content: text,
  display: true,
});

const draft = (text: string): CustomMessageEntryDraft => ({
  type: "custom_message",
  ...message(text),
});

/**
 * Shows input that Herdr Core typed into Pi as Herdr messages instead of
 * the user's own.
 *
 * Recognized input becomes one custom message per submission, holding the
 * original text unchanged, so the model sees exactly what it saw as a user
 * message and still answers it. The format is not proof of origin and grants
 * nothing: the custom message reaches the model with the user role, like
 * the input it replaces.
 *
 * While Pi is busy, messages wait here rather than in Pi's steering queue:
 * Escape and dequeue clear that queue and restore only user text, which
 * would silently drop a note Herdr already counts as delivered. They are
 * delivered at the same points instead: steering after the next completed
 * turn, follow-ups when the run would settle. Whatever is left when the run
 * settles, for example after Escape, is recorded without starting a turn.
 *
 * `pi.sendMessage()` does not report failures to the caller. If an idle run
 * fails while it is being prepared, before the message is stored, Pi only
 * reports an extension error and the message is lost, as a typed prompt
 * would be. Messages queued during that start wait for the next run.
 */
export default function herdr(pi: ExtensionAPI) {
  let queued: Queued[] = [];

  const showQueue = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setStatus(
      HERDR_MESSAGE,
      queued.length > 0 ? `${INCOMING} ${queued.length} queued` : undefined,
    );
  };

  const take = (ctx: ExtensionContext, deliverAs?: Delivery) => {
    const due = queued.filter(
      (item) => !deliverAs || item.deliverAs === deliverAs,
    );
    if (due.length > 0) {
      queued = queued.filter((item) => !due.includes(item));
      showQueue(ctx);
    }
    return due.map((item) => item.text);
  };

  const deliver = (entries: SessionBoundaryDraft[], texts: string[]) =>
    texts.length === 0
      ? undefined
      : { entries: [...entries, ...texts.map(draft)], continue: true };

  pi.registerMessageRenderer(HERDR_MESSAGE, renderHerdrMessage);

  pi.on("input", (event, ctx) => {
    // Herdr types into the interactive editor. Other sources, print and RPC
    // modes and input with attachments keep Pi's normal handling.
    if (
      ctx.mode !== "tui" ||
      event.source !== "interactive" ||
      (event.images?.length ?? 0) > 0 ||
      !parseHerdrInput(event.text)
    ) {
      return { action: "continue" };
    }
    // Without a model a run cannot start; let Pi report it for the input.
    if (!ctx.model) return { action: "continue" };

    // Pi recorded `streamingBehavior` when the prompt arrived, but handlers
    // before this one may have awaited. Route by the live state.
    if (ctx.isIdle()) {
      pi.sendMessage(message(event.text), { triggerTurn: true });
    } else {
      queued.push({
        text: event.text,
        deliverAs: event.streamingBehavior ?? "steer",
      });
      showQueue(ctx);
    }
    return { action: "handled" };
  });

  pi.on("turn_end", (event, ctx) => {
    // A tool turn interrupted by Escape still reports "completed"; leave its
    // messages for agent_settled, which records them without a new turn.
    if (event.outcome !== "completed" || ctx.signal?.aborted) return;
    return deliver(event.entries, take(ctx, "steer"));
  });

  // Aborted runs skip this boundary; failed ones still continue for queued
  // input, as they would for queued user messages.
  pi.on("agent_before_settle", (event, ctx) =>
    deliver(event.entries, take(ctx)),
  );

  pi.on("agent_settled", (event, ctx) => {
    const left = take(ctx);
    // Pi defers a triggered turn until settled handlers finish, so only the
    // last message starts it and earlier ones are recorded right away.
    left.forEach((text, index) =>
      pi.sendMessage(message(text), {
        triggerTurn: !event.aborted && index === left.length - 1,
      }),
    );
  });

  // Normally empty: Escape settles the run first. Record the rest rather
  // than lose it; Pi can only append it while no run is active.
  pi.on("session_shutdown", (_event, ctx) => {
    for (const text of take(ctx)) {
      pi.sendMessage(message(text), { triggerTurn: false });
    }
  });
}
