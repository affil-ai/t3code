import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString, TurnItemId } from "./baseSchemas.ts";

/** How a card names one of several values, and how the agent's refs are keyed. */
export const SecretRequestFieldName = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9_]{0,31}$/),
);
export type SecretRequestFieldName = typeof SecretRequestFieldName.Type;

/** One input on a card that asks for several values at once, e.g. a login and a password. */
export const SecretRequestField = Schema.Struct({
  name: SecretRequestFieldName,
  label: TrimmedNonEmptyString,
  placeholder: Schema.optional(TrimmedNonEmptyString),
});
export type SecretRequestField = typeof SecretRequestField.Type;

export const SECRET_REQUEST_MAX_FIELDS = 8;

/** A secret's value as the user enters it; generous for keys and certificates. */
const SecretValue = TrimmedNonEmptyString.check(Schema.isMaxLength(64 * 1024));

/**
 * A saved value is kept by the server under a SecretRef bound to the asking
 * thread; the thread learns only the status. A card with fields is saved with
 * one value per field.
 */
export const SecretRequestAnswerInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  answer: Schema.Union([
    Schema.Struct({ type: Schema.Literal("save"), secret: SecretValue }),
    Schema.Struct({
      type: Schema.Literal("save"),
      fields: Schema.Record(SecretRequestFieldName, SecretValue),
    }),
    Schema.Struct({ type: Schema.Literal("decline") }),
  ]),
});
export type SecretRequestAnswerInput = typeof SecretRequestAnswerInput.Type;

const SECRET_REQUEST_FAILURE_MESSAGES = {
  load_failed: "Could not load the secret request.",
  not_found: "This secret request no longer exists.",
  already_answered: "This secret request was already answered.",
  agent_stopped: "The agent that asked has stopped, so this secret can't be used.",
  fields_mismatch: "Fill in every field on this request.",
  store_failed: "Could not store the secret.",
  record_failed: "Saved the secret, but could not update the request.",
  invalid_ref: "That secretRef is not valid.",
  read_failed: "Could not read the secret.",
  ref_unavailable:
    "That secretRef does not exist or belongs to another thread. Ask the user with request_secret from this thread.",
  ref_expired: "That secretRef expired. Ask the user again with request_secret.",
} as const;

export const SecretRequestFailureReason = Schema.Literals(
  Object.keys(SECRET_REQUEST_FAILURE_MESSAGES) as Array<
    keyof typeof SECRET_REQUEST_FAILURE_MESSAGES
  >,
);
export type SecretRequestFailureReason = typeof SecretRequestFailureReason.Type;

export class SecretRequestError extends Schema.TaggedError<SecretRequestError>()(
  "SecretRequestError",
  {
    reason: SecretRequestFailureReason,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return SECRET_REQUEST_FAILURE_MESSAGES[this.reason];
  }
}
