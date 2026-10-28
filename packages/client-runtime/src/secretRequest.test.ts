import { SecretRequestError, ThreadId, TurnItemId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  secretRequestAnswerInput,
  secretRequestDisplay,
  secretRequestFailureMessage,
  secretRequestInputs,
  secretRequestPrivacyNote,
} from "./secretRequest.ts";

const item = {
  id: TurnItemId.make("turn-item:secret-request:1"),
  threadId: ThreadId.make("thread-1"),
  label: "GitHub webhook secret",
};
const loginItem = {
  ...item,
  label: "Registry login",
  fields: [
    { name: "username", label: "Username" },
    { name: "password", label: "Password", placeholder: "Paste the password" },
  ],
};

describe("secretRequestDisplay", () => {
  it("never offers the form for a request inherited from another thread", () => {
    expect(secretRequestDisplay({ secretStatus: "pending" }, "inherited")).toEqual({
      kind: "pending-elsewhere",
      label: "Waiting for an answer in the original thread",
    });
    expect(secretRequestDisplay({ secretStatus: "saved" }, "inherited")).toMatchObject({
      outcome: "saved",
    });
  });
});

describe("secretRequestInputs", () => {
  it("shows one input for a single value and one per field otherwise", () => {
    expect(secretRequestInputs(item)).toEqual([
      { key: "", label: "GitHub webhook secret", placeholder: "Paste the secret" },
    ]);
    expect(secretRequestInputs(loginItem)).toEqual([
      { key: "username", label: "Username", placeholder: "Paste the secret" },
      { key: "password", label: "Password", placeholder: "Paste the password" },
    ]);
  });
});

describe("secretRequestAnswerInput", () => {
  it("refuses a blank save and trims the value the server will store", () => {
    expect(secretRequestAnswerInput(item, { type: "save", values: { "": "   " } })).toBeNull();
    expect(secretRequestAnswerInput(item, { type: "save", values: { "": " whsec_1 " } })).toEqual({
      threadId: item.threadId,
      turnItemId: item.id,
      answer: { type: "save", secret: "whsec_1" },
    });
    expect(secretRequestAnswerInput(item, { type: "decline" })).toEqual({
      threadId: item.threadId,
      turnItemId: item.id,
      answer: { type: "decline" },
    });
  });

  it("saves a card with fields only once every field is filled", () => {
    expect(
      secretRequestAnswerInput(loginItem, { type: "save", values: { username: "bot" } }),
    ).toBeNull();
    expect(
      secretRequestAnswerInput(loginItem, {
        type: "save",
        values: { username: " bot ", password: "hunter2", extra: "ignored" },
      }),
    ).toEqual({
      threadId: item.threadId,
      turnItemId: item.id,
      answer: { type: "save", fields: { username: "bot", password: "hunter2" } },
    });
  });
});

describe("secretRequestPrivacyNote", () => {
  it("does not promise to hide a value that the agent's commands can read", () => {
    expect(secretRequestPrivacyNote({})).toBe("Stored securely, never shown to the agent");
    expect(secretRequestPrivacyNote({ delivery: "file" })).not.toContain("never shown");
  });
});

describe("secretRequestFailureMessage", () => {
  it("passes through server errors but hides anything that could echo the payload", () => {
    expect(
      secretRequestFailureMessage(new SecretRequestError({ reason: "already_answered" })),
    ).toBe("This secret request was already answered.");
    expect(secretRequestFailureMessage(new Error('Expected string, got "whsec_1"'))).toBe(
      "Could not answer the request. Try again.",
    );
    expect(secretRequestFailureMessage(undefined)).toBe("Could not answer the request. Try again.");
  });
});
