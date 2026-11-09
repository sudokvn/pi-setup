import type { MarkdownTransformer } from "@earendil-works/pi-coding-agent";
import { blockquote } from "../shared/blockquote.ts";

// A fenced block must start on its own line, so the marker cannot share it.
const FENCE_START = /^\s*(```|~~~)/;

function prefixMarkdown(prefix: string, markdown: string) {
  return FENCE_START.test(markdown)
    ? `${prefix}\n${markdown}`
    : `${prefix} ${markdown}`;
}

/**
 * Marks who is speaking without any filled blocks.
 *
 * The user's message is rendered as a block quote: Pi draws `│ ` on every
 * wrapped row in `mdQuoteBorder`, which is the closest a theme can get to a
 * left bar on the message. Only the rendering changes; the stored message,
 * `/tree` copies and the model input keep the original text. Pi renders quote
 * text italic; that goes away once Pi offers a border role for user messages.
 *
 * Reasoning gets a bold label so it is not mistaken for the answer; Pi already
 * renders the whole block italic, so an italic label would vanish.
 */
export const markTranscriptRoles: MarkdownTransformer = (
  markdown,
  { messageType },
) => {
  switch (messageType) {
    case "user":
      return blockquote(markdown);
    case "assistant-thinking":
      return prefixMarkdown("**Thinking:**", markdown);
    default:
      return markdown;
  }
};
