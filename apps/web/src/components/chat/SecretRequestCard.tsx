import {
  SECRET_REQUEST_PRIVACY_NOTE,
  secretRequestAnswerInput,
  secretRequestDisplay,
  secretRequestFailureMessage,
  secretRequestInputs,
  type SecretRequestItem,
} from "@t3tools/client-runtime/secret-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { CheckIcon, LockIcon, MinusIcon, ShieldCheckIcon } from "lucide-react";
import { useId, useRef, useState, type FormEvent } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { WorkLogRow } from "./WorkLog";

/**
 * Inline card for a secret an agent asked the user for. The typed values live
 * only in this component's state and the RPC payload: they are never logged,
 * toasted, or persisted, and the fields clear once the answer is sent.
 */
export function SecretRequestCard(props: {
  readonly environmentId: EnvironmentId;
  readonly item: SecretRequestItem;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
}) {
  const { item } = props;
  const display = secretRequestDisplay(item, props.visibility);
  if (display.kind === "answered" || display.kind === "pending-elsewhere") {
    const Icon =
      display.kind === "pending-elsewhere"
        ? LockIcon
        : display.outcome === "saved"
          ? CheckIcon
          : MinusIcon;
    return (
      <WorkLogRow
        data-v2-item-type={item.type}
        icon={<Icon className="size-3.5 text-icon-muted" aria-hidden />}
        label={
          <>
            {item.label} · {display.label}
          </>
        }
      />
    );
  }
  return <PendingSecretRequestForm environmentId={props.environmentId} item={item} />;
}

function PendingSecretRequestForm(props: {
  readonly environmentId: EnvironmentId;
  readonly item: SecretRequestItem;
}) {
  const { item } = props;
  const inputs = secretRequestInputs(item);
  // A card with fields titles itself; a single field is labelled by the card's title.
  const single = item.fields === undefined;
  const inputId = useId();
  const errorId = useId();
  const privacyId = useId();
  const answer = useAtomCommand(serverEnvironment.answerSecretRequest, {
    label: "answer secret request",
    // The failure cause holds the request; keep it out of the console.
    reportFailure: false,
    reportDefect: false,
  });
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Enter then a click can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);

  const send = async (
    reply:
      | { readonly type: "save"; readonly values: Readonly<Record<string, string>> }
      | { readonly type: "decline" },
  ) => {
    const input = secretRequestAnswerInput(item, reply);
    if (input === null || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    const result = await answer({ environmentId: props.environmentId, input }).finally(() => {
      inFlight.current = false;
      setSubmitting(false);
    });
    if (result._tag === "Success") {
      // The card switches to its answered row once the item updates.
      setValues({});
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setError(secretRequestFailureMessage(squashAtomCommandFailure(result)));
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void send({ type: "save", values });
  };

  // Same hierarchy as a chat card: what is asked, why, the field, then the
  // promise about where the value goes.
  return (
    <form
      data-v2-item-type={item.type}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
      onSubmit={onSubmit}
      autoComplete="off"
      // A click anywhere on the card targets its field, so a paste that
      // follows lands here rather than with the composer.
      onPointerDown={(event) => {
        if (!(event.target instanceof HTMLElement)) return;
        if (event.target.closest("input, button, a")) return;
        document.getElementById(`${inputId}-0`)?.focus();
      }}
    >
      <div className="flex min-w-0 flex-col gap-1">
        {single ? (
          <label htmlFor={`${inputId}-0`} className="text-sm font-medium text-foreground">
            {item.label}
          </label>
        ) : (
          <p className="text-sm font-medium text-foreground">{item.label}</p>
        )}
        {item.reason.trim() ? <p className="text-sm text-muted-foreground">{item.reason}</p> : null}
      </div>
      {inputs.map((input, index) => (
        <div key={input.key} className="flex min-w-0 flex-col gap-1.5">
          {single ? null : (
            <label htmlFor={`${inputId}-${index}`} className="text-xs text-muted-foreground">
              {input.label}
            </label>
          )}
          <div className="flex min-w-0 items-center gap-2">
            <div className="min-w-0 flex-1">
              <Input
                id={`${inputId}-${index}`}
                // Masked text rather than a password field: browsers offer to
                // save any submitted password, and this is not a login.
                type="text"
                className="[-webkit-text-security:disc]"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                // Password managers otherwise offer to save or fill this field.
                data-1p-ignore
                data-lpignore="true"
                data-bwignore
                placeholder={input.placeholder}
                value={values[input.key] ?? ""}
                disabled={submitting}
                aria-invalid={error !== null || undefined}
                aria-describedby={error !== null ? `${privacyId} ${errorId}` : privacyId}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setValues((current) => ({ ...current, [input.key]: value }));
                }}
              />
            </div>
            {index === inputs.length - 1 ? (
              <Button
                type="submit"
                disabled={
                  submitting || secretRequestAnswerInput(item, { type: "save", values }) === null
                }
              >
                Save securely
              </Button>
            ) : null}
          </div>
        </div>
      ))}
      {error !== null ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex min-w-0 items-center justify-between gap-2">
        <p
          id={privacyId}
          className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
        >
          <ShieldCheckIcon className="size-3.5 shrink-0" aria-hidden />
          {SECRET_REQUEST_PRIVACY_NOTE}
        </p>
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          disabled={submitting}
          onClick={() => void send({ type: "decline" })}
        >
          Decline
        </Button>
      </div>
    </form>
  );
}
