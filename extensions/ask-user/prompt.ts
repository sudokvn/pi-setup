/** Model-facing schema descriptions for ask-user questions and answer options. */
export const ASK_USER_PARAMETER_DESCRIPTIONS = {
  context:
    "Optional decision context displayed directly above the question border as plain Markdown, without a tool-output wrapper. At most 300 characters in one paragraph: the essential fact or trade-off and your recommendation. Omit it for self-explanatory questions. No lists, reports, filler or repeated findings; detailed explanations belong in normal conversation.",
  optionLabel: "Short display label for this option",
  optionDescription: "Optional one-line description shown below the label",
  question: "The question to ask the user",
  questionLabel:
    "Optional short contextual label for this question, such as 'Scope' or 'Priority'",
  questions:
    "Between 1 and 4 questions. Use one array item when asking a single question. Every question must be answered before the batch can be submitted.",
  multiSelect:
    "Allow multiple options to be selected. Defaults to false. Use when the choices are not mutually exclusive; the user can also add a custom answer.",
  options:
    "Between 2 and 5 answer options. A free-form 'write my own answer' option is always appended automatically - never include one yourself.",
};

/** Describes ask-user's single and batched multiple-choice question shapes. */
export const ASK_USER_TOOL_DESCRIPTION =
  "Ask the user one multiple-choice question or a batch of up to 4 questions. Pass every question in the questions array, including when asking only one. Each question has 2-5 options and accepts one answer by default; set multiSelect to true when multiple choices are valid. A free-form 'write my own answer' option is always added automatically and can accompany selections on multi-select questions. Every question must be answered before submitting a batch, and the user may dismiss the whole questionnaire without submitting anything. Optional context is limited to one short paragraph (300 characters) directly above the question border. Omit it when the question is self-explanatory; keep detailed findings in normal conversation.";

/** Adds ask-user's single and batched multiple-choice capability to the model prompt. */
export const ASK_USER_PROMPT_SNIPPET =
  "Ask the user one or up to 4 batched multiple-choice questions (2-5 options each, plus a free-form answer)";

const FREE_TEXT_GUIDANCE =
  "Free-form ask-user text may be a question, correction, or refusal. Do not assume it resolves the requested decision or authorization. Answer clarification questions in plain text before proceeding or asking another decision question.";

/** Guides the model to request needed decisions and interpret responses without assuming consent. */
export const ASK_USER_PROMPT_GUIDELINES = [
  "Use ask-user when you need a decision from the user and the likely answers can be enumerated. Do not use ask-user merely to end a response or replace an explanation; answer the user's questions first.",
  FREE_TEXT_GUIDANCE,
  "Batch independent questions into one ask-user call when that is more efficient. Ask dependent follow-up questions only after receiving the earlier answer.",
  "Questions are single-select by default. Set multiSelect to true when multiple choices are valid. Never include a free-form option yourself; ask-user adds one automatically.",
  "Keep the questionnaire brief: short questions and choices, with no reports or repeated findings. Add context only when needed to decide: one paragraph, at most 300 characters, containing the essential trade-off and your recommendation. It appears directly above the question border. Omit filler context for simple questions; put detailed explanations in normal messages.",
];

export type ReportedAnswer = {
  label: string;
  answer: string;
} & (
  | { wasCustom: boolean; index?: number; selected?: never }
  | { selected: string[]; wasCustom?: never; index?: never }
);

function describeMultiAnswer(selected: string[], custom: string) {
  const parts = [];
  if (selected.length > 0) {
    parts.push(
      `User selected options: ${selected.map((label) => JSON.stringify(label)).join(", ")}`,
    );
  }
  if (custom) parts.push(`User wrote: ${custom}`);
  return parts.join("\n");
}

/** Builds the behavioral tool-result message returned to the parent model for an ask-user outcome. */
export function buildAskUserResultMessage(
  outcome:
    | { kind: "no-ui" }
    | { kind: "cancelled" }
    | { kind: "dismissed" }
    | { kind: "custom"; answer: string }
    | { kind: "selected"; answer: string; index: number | undefined }
    | { kind: "multi"; selected: string[]; answer: string }
    | { kind: "batch"; answers: ReportedAnswer[] },
) {
  switch (outcome.kind) {
    case "no-ui":
      return "No interactive UI is available, so the questionnaire could not be shown. Ask the user in plain text instead.";
    case "cancelled":
      return "Cancelled";
    case "dismissed":
      return "User dismissed the questionnaire without submitting answers. Do not assume any answers; proceed accordingly or ask differently.";
    case "custom":
      return `${FREE_TEXT_GUIDANCE}\n\nUser wrote: ${outcome.answer}`;
    case "selected":
      return `User selected option ${outcome.index}: ${outcome.answer}`;
    case "multi":
      return [
        ...(outcome.answer ? [FREE_TEXT_GUIDANCE, ""] : []),
        describeMultiAnswer(outcome.selected, outcome.answer),
      ].join("\n");
    case "batch":
      return [
        ...(outcome.answers.some(
          (answer) =>
            (answer.wasCustom || answer.selected !== undefined) &&
            answer.answer,
        )
          ? [FREE_TEXT_GUIDANCE, ""]
          : []),
        "User responded:",
        ...outcome.answers.map((answer) => {
          if (answer.selected !== undefined) {
            return `${answer.label}: ${describeMultiAnswer(answer.selected, answer.answer)}`;
          }
          return answer.wasCustom
            ? `${answer.label}: User wrote: ${answer.answer}`
            : `${answer.label}: user selected option ${answer.index}: ${answer.answer}`;
        }),
      ].join("\n");
  }
}
