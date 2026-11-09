/**
 * Prefixes every line with `> `, so Markdown renders the text as one block
 * quote. Blank lines become a bare `>`: an unprefixed blank line would end the
 * quote and start a second one after a gap. Fenced code keeps working because
 * its fence lines are prefixed too.
 */
export function blockquote(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
}
