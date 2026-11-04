import { assert, it } from "vite-plus/test";

import {
  applyClick,
  applyText,
  type Asked,
  finalAnswers,
  type Question,
  questionBlocks,
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
  const closed = JSON.stringify(questionBlocks(asked([pick]), "Answered elsewhere."));
  assert.include(closed, "Answered elsewhere.");
  assert.notInclude(closed, '"actions"');
  // Each button has its own action id, as Slack requires within a message.
  const ids = buttons(asked([pick, many])).map((button) => JSON.stringify(button));
  assert.strictEqual(new Set(ids).size, ids.length);
});
