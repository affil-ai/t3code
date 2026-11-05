import { assert, it } from "vite-plus/test";

import {
  applyClick,
  applyReply,
  applyText,
  type Asked,
  finalAnswers,
  numberedQuestion,
  type Question,
  questionBlocks,
  questionChoices,
} from "./questions.ts";

const pick: Question = {
  id: "env",
  header: "Deploy",
  question: "Which environment?",
  options: [
    { label: "Staging", description: "Safe" },
    { label: "Production", description: "Live", value: "prod" },
  ],
};
const many: Question = {
  id: "checks",
  header: "Checks",
  question: "Which checks?",
  options: [
    { label: "Lint", description: "" },
    { label: "Tests", description: "" },
  ],
  multiSelect: true,
  allowCustomAnswer: false,
};
const asked = (questions: ReadonlyArray<Question>): Asked => ({
  requestId: "req-1",
  questions,
  answers: {},
  submitted: [],
});

const buttons = (state: Asked) =>
  questionBlocks(state)
    .filter((block) => block.type === "actions")
    .flatMap((block) => block.elements as Array<{ value: string; text: { text: string } }>);

it("answers a question with an option's value, or its label", () => {
  const start = asked([pick]);
  const [staging, production] = buttons(start);
  assert.deepStrictEqual(finalAnswers(applyClick(start, staging!.value)), { env: "Staging" });
  assert.deepStrictEqual(finalAnswers(applyClick(start, production!.value)), { env: "prod" });
  assert.isUndefined(finalAnswers(start));
});

it("collects multiple choices until they are submitted", () => {
  let state = asked([many]);
  const [lint, tests, submit] = buttons(state);
  assert.strictEqual(submit?.text.text, "Submit");
  // Submitting nothing changes nothing.
  assert.strictEqual(applyClick(state, submit!.value), state);
  state = applyClick(state, lint!.value);
  state = applyClick(state, tests!.value);
  state = applyClick(state, lint!.value);
  assert.isUndefined(finalAnswers(state));
  state = applyClick(state, submit!.value);
  assert.deepStrictEqual(finalAnswers(state), { checks: ["Tests"] });
});

it("takes typed text for the first open question that allows it", () => {
  const state = asked([pick, many]);
  const typed = applyText(state, "  Preview  ");
  assert.deepStrictEqual(typed?.answers, { env: "Preview" });
  // The next open question takes only its buttons.
  assert.isUndefined(applyText(typed!, "everything"));
  assert.isUndefined(applyText(state, "   "));
});

it("ignores stale and foreign clicks", () => {
  const state = asked([pick]);
  const [staging] = buttons(state);
  const answered = applyClick(state, staging!.value);
  assert.strictEqual(applyClick(answered, staging!.value), answered);
  assert.strictEqual(applyClick(state, staging!.value.replace("req-1", "req-2")), state);
  assert.strictEqual(applyClick(state, "not json"), state);
});

it("shows answers in place of buttons, and a closing note", () => {
  const [staging] = buttons(asked([pick]));
  const answered = applyClick(asked([pick]), staging!.value);
  const blocks = questionBlocks(answered);
  assert.isUndefined(blocks.find((block) => block.type === "actions"));
  assert.include(JSON.stringify(blocks), "Answered: Staging");
  assert.include(
    JSON.stringify(questionBlocks({ ...answered, answeredBy: "U1" })),
    "Answered by <@U1>: Staging",
  );
  const closed = JSON.stringify(questionBlocks(asked([pick]), "Answered elsewhere."));
  assert.include(closed, "Answered elsewhere.");
  assert.notInclude(closed, '"actions"');
  // Each button has its own action id, as Slack requires within a message.
  const ids = buttons(asked([pick, many])).map((button) => JSON.stringify(button));
  assert.strictEqual(new Set(ids).size, ids.length);
});

it("bolds a header on its own line and leaves out a generic one", () => {
  const sectionText = (question: Question) =>
    (questionBlocks(asked([question]))[0] as { text: { text: string } }).text.text;
  assert.strictEqual(
    sectionText({ ...pick, header: "Question", question: "Which <colour>?" }),
    "Which &lt;colour&gt;?",
  );
  assert.strictEqual(
    sectionText({ ...pick, header: "Deploy", question: "Which environment?" }),
    "*Deploy*\nWhich environment?",
  );
});

it("lists only the option descriptions that add to their labels", () => {
  const question: Question = {
    ...pick,
    options: [
      { label: "Red", description: "Red" },
      { label: "Green", description: "green." },
      { label: "Blue", description: "The calm one" },
    ],
  };
  const text = JSON.stringify(
    questionBlocks(asked([question])).filter((b) => b.type === "context"),
  );
  assert.include(text, "*Blue*: The calm one");
  assert.notInclude(text, "*Red*");
  assert.notInclude(text, "*Green*");
  const plain = { ...question, options: question.options.slice(0, 2) };
  const contexts = questionBlocks(asked([plain])).filter((b) => b.type === "context");
  assert.notInclude(JSON.stringify(contexts), "*Red*");
});

it("asks without buttons as numbered text, and takes a number, a label or own words", () => {
  const asked: Asked = {
    requestId: "r",
    questions: [
      {
        id: "q",
        header: "Color",
        question: "Which color?",
        options: [
          { label: "Red", description: "" },
          { label: "Blue", description: "Calm" },
        ],
      },
    ],
    answers: {},
    submitted: [],
  };
  assert.strictEqual(
    numberedQuestion(asked),
    "Color\nWhich color?\n1. Red\n2. Blue – Calm\n\nReply with a number, or with your own answer.",
  );
  assert.deepStrictEqual(applyReply(asked, "2")?.answers, { q: "Blue" });
  assert.deepStrictEqual(applyReply(asked, " red ")?.answers, { q: "Red" });
  assert.deepStrictEqual(applyReply(asked, "green")?.answers, { q: "green" });
  assert.deepStrictEqual(applyReply(asked, "1, 2")?.answers, { q: "1, 2" });
});

it("offers a single-choice question's labels to pick, and takes a picked label back as the answer", () => {
  const state = asked([pick, many]);
  // Linear sends a pick back as the option's label; Production's answer is its value.
  assert.deepStrictEqual(questionChoices(state), {
    question: "Deploy\nWhich environment?",
    options: ["Staging", "Production"],
  });
  assert.deepStrictEqual(applyReply(state, "Production")?.answers, { env: "prod" });
  // Multiple choice, and questions without options, stay numbered text.
  const next = applyReply(state, "Staging")!;
  assert.isUndefined(questionChoices(next));
  assert.isUndefined(
    questionChoices(asked([{ id: "free", header: "Question", question: "Why?", options: [] }])),
  );
});
