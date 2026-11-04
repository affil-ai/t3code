/**
 * An agent's question, asked in the chat and answered with buttons or typed
 * text, then handed back to T3 in the shape `t3_pending_request` takes: an
 * option's value (or its label), a list for multiple choice, or the text.
 */

/** One question as `t3_pending_request` reads it. */
export interface Question {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<{
    readonly label: string;
    readonly description: string;
    readonly value?: string | undefined;
  }>;
  readonly multiSelect?: boolean | undefined;
  readonly allowCustomAnswer?: boolean | undefined;
}

export type Answer = string | ReadonlyArray<string>;

/** A pending request and what has been answered so far. */
export interface Asked {
  readonly requestId: string;
  readonly questions: ReadonlyArray<Question>;
  /** By question id. A multiple-choice question collects its picks here until it is submitted. */
  readonly answers: Readonly<Record<string, Answer>>;
  /** Multiple-choice questions whose picks were submitted. */
  readonly submitted: ReadonlyArray<string>;
  /** The chat user who gave the last answer. */
  readonly answeredBy?: string | undefined;
}

export const ANSWER_ACTION_ID = "t3_answer";

/** What a button carries: the question and option by position, or submit. */
interface ButtonValue {
  readonly r: string;
  readonly q: number;
  readonly o: number | "submit";
}

const optionValue = (option: Question["options"][number]) => option.value ?? option.label;

export const allowsText = (question: Question) => question.allowCustomAnswer !== false;

function isAnswered(asked: Asked, question: Question): boolean {
  const answer = asked.answers[question.id];
  if (answer === undefined) return false;
  if (typeof answer === "string") return true;
  return asked.submitted.includes(question.id);
}

/** The first question still open, if any. */
export function openQuestion(asked: Asked): Question | undefined {
  return asked.questions.find((question) => !isAnswered(asked, question));
}

/** The answers to hand back once every question has one; nothing before that. */
export function finalAnswers(asked: Asked): Record<string, Answer> | undefined {
  return openQuestion(asked) === undefined ? { ...asked.answers } : undefined;
}

/** Applies a button click. Unknown or stale clicks change nothing. */
export function applyClick(asked: Asked, rawValue: string): Asked {
  let value: ButtonValue;
  try {
    value = JSON.parse(rawValue) as ButtonValue;
  } catch {
    return asked;
  }
  const question = asked.questions[value.q];
  if (value.r !== asked.requestId || question === undefined || isAnswered(asked, question)) {
    return asked;
  }
  if (value.o === "submit") {
    const picks = asked.answers[question.id];
    if (!Array.isArray(picks) || picks.length === 0) return asked;
    return { ...asked, submitted: [...asked.submitted, question.id] };
  }
  const option = question.options[value.o];
  if (option === undefined) return asked;
  const picked = optionValue(option);
  if (!question.multiSelect) {
    return { ...asked, answers: { ...asked.answers, [question.id]: picked } };
  }
  const current = asked.answers[question.id];
  const picks = Array.isArray(current) ? current : [];
  const next = picks.includes(picked)
    ? picks.filter((each) => each !== picked)
    : [...picks, picked];
  return { ...asked, answers: { ...asked.answers, [question.id]: next } };
}

/**
 * Applies typed text to the first open question that takes text. Returns
 * nothing when no open question takes it, so the text can be refused.
 */
export function applyText(asked: Asked, text: string): Asked | undefined {
  const trimmed = text.trim();
  const question = openQuestion(asked);
  if (trimmed === "" || question === undefined || !allowsText(question)) return undefined;
  return {
    ...asked,
    answers: { ...asked.answers, [question.id]: trimmed },
    submitted: question.multiSelect ? [...asked.submitted, question.id] : asked.submitted,
  };
}

const plain = (text: string) => ({ type: "plain_text", text: text.slice(0, 75), emoji: true });

/** How an answer reads back: the labels of the options picked, or the text. */
function answerText(question: Question, answer: Answer | undefined): string {
  if (answer === undefined) return "";
  const values = typeof answer === "string" ? [answer] : answer;
  return values
    .map(
      (value) => question.options.find((option) => optionValue(option) === value)?.label ?? value,
    )
    .join(", ");
}

/** Slack's mrkdwn special characters, escaped so agent text shows as written. */
const escapeMrkdwn = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** True when the description is empty or says no more than the label. */
const sameText = (description: string, label: string) => {
  const plainText = (text: string) =>
    text
      .trim()
      .toLowerCase()
      .replace(/[.!]+$/, "");
  return plainText(description) === "" || plainText(description) === plainText(label);
};

/**
 * A question's text, with its header in bold on a line of its own; Slack's
 * bold can't span a line break. A header that only says "Question" is left out.
 */
function heading(question: Question): string {
  const header = question.header.trim();
  const text = question.question.trim();
  const lines = [];
  if (header !== "" && !/^question$/i.test(header) && header !== text) {
    lines.push(`*${escapeMrkdwn(header)}*`);
  }
  if (text !== "") lines.push(escapeMrkdwn(text));
  return lines.join("\n").slice(0, 2900) || "*Question*";
}

/**
 * The Slack blocks for the questions: answered ones show their answer, the
 * open ones a button per option. `closed` drops the buttons, with a note.
 */
export function questionBlocks(
  asked: Asked,
  closed?: string | undefined,
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  for (const [index, question] of asked.questions.entries()) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: heading(question) } });
    // A description that only repeats its option's label would show every option twice.
    const descriptions = question.options
      .filter((option) => !sameText(option.description, option.label))
      .map((option) => `*${escapeMrkdwn(option.label)}*: ${escapeMrkdwn(option.description)}`);
    if (descriptions.length > 0 && !isAnswered(asked, question) && closed === undefined) {
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: descriptions.join("\n").slice(0, 2900) }],
      });
    }
    if (isAnswered(asked, question)) {
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Answered${asked.answeredBy ? ` by <@${asked.answeredBy}>` : ""}: ${answerText(question, asked.answers[question.id])}`,
          },
        ],
      });
      continue;
    }
    if (closed !== undefined) continue;
    const picks = asked.answers[question.id];
    const buttons = question.options.slice(0, 24).map((option, o) => ({
      type: "button",
      text: plain(option.label),
      action_id: `${ANSWER_ACTION_ID}:${index}:${o}`,
      value: JSON.stringify({ r: asked.requestId, q: index, o } satisfies ButtonValue),
      ...(Array.isArray(picks) && picks.includes(optionValue(option)) ? { style: "primary" } : {}),
    }));
    if (question.multiSelect) {
      buttons.push({
        type: "button",
        text: plain("Submit"),
        action_id: `${ANSWER_ACTION_ID}:${index}:submit`,
        value: JSON.stringify({ r: asked.requestId, q: index, o: "submit" } satisfies ButtonValue),
        style: "primary",
      });
    }
    if (buttons.length > 0) blocks.push({ type: "actions", elements: buttons });
    if (allowsText(question)) {
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: "Or reply in this thread with your own answer." }],
      });
    }
  }
  if (closed !== undefined) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: closed }] });
  }
  return blocks;
}

/** Plain text for notifications. */
export function questionText(asked: Asked): string {
  return asked.questions
    .map((question) => question.question || question.header)
    .join("\n")
    .slice(0, 3000);
}

/**
 * The open question as plain text with numbered options, for a platform
 * without buttons. It is answered with `applyReply`.
 */
export function numberedQuestion(asked: Asked): string {
  const question = openQuestion(asked);
  if (question === undefined) return "";
  const title = [question.header, question.question].filter(Boolean);
  const lines = [title.length === 2 && title[0] === "Question" ? title[1]! : title.join("\n")];
  question.options.forEach((option, index) => {
    const description = sameText(option.description, option.label)
      ? ""
      : ` – ${option.description}`;
    lines.push(`${index + 1}. ${option.label}${description}`);
  });
  if (question.options.length > 0) {
    const how = question.multiSelect
      ? "Reply with one or more numbers, such as 1, 3"
      : "Reply with a number";
    lines.push("", allowsText(question) ? `${how}, or with your own answer.` : `${how}.`);
  }
  return lines.join("\n").slice(0, 3000);
}

/**
 * Applies a typed reply to the open question: option numbers, an option's
 * label, or, where the question takes it, the text itself.
 */
export function applyReply(asked: Asked, text: string): Asked | undefined {
  const question = openQuestion(asked);
  if (question === undefined) return undefined;
  const trimmed = text.trim();
  const numbers = /^\d+(?:\s*[,\s]\s*\d+)*$/.test(trimmed)
    ? trimmed.split(/[,\s]+/).map((each) => Number(each) - 1)
    : undefined;
  const byLabel = question.options.findIndex(
    (option) => option.label.trim().toLowerCase() === trimmed.toLowerCase(),
  );
  const picked =
    numbers !== undefined && numbers.every((index) => question.options[index] !== undefined)
      ? [...new Set(numbers)]
      : byLabel >= 0
        ? [byLabel]
        : undefined;
  if (picked === undefined || (!question.multiSelect && picked.length > 1)) {
    return applyText(asked, text);
  }
  const values = picked.map((index) => optionValue(question.options[index]!));
  return question.multiSelect
    ? {
        ...asked,
        answers: { ...asked.answers, [question.id]: values },
        submitted: [...asked.submitted, question.id],
      }
    : { ...asked, answers: { ...asked.answers, [question.id]: values[0]! } };
}
