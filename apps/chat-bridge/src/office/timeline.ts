/**
 * T3 activity items as Office timeline items (thinking, tool calls, steps). Office fails a run when an
 * item comes again with the same `seqEnd` and a different digest, so an item still going carries only
 * what can't change (position × 4 + 1), and comes again in full once it ends (+ 2).
 */
import * as NodeCrypto from "node:crypto";

import { type ActivityItem, isOpen, json, oneLine, redactSecrets, work } from "../activity.ts";

/** Detail and tool output kept per step; the chat shows a short excerpt. */
export const DETAIL_CHARS = 2_000;
const LABEL_CHARS = 200;

export type PresentationItem =
  | { readonly type: "reasoning" }
  | {
      readonly type: "assistant_message";
      readonly text: string;
      readonly files: ReadonlyArray<never>;
    }
  | {
      readonly type: "tool_call";
      readonly callId: string;
      readonly name: string;
      readonly status: "running" | "completed" | "failed" | "canceled";
      readonly payloadEncoding: "json-v1";
      readonly inputJson: string;
      readonly outputJson?: string;
      readonly errorText?: string;
    }
  | {
      readonly type: "work_log";
      readonly label: string;
      readonly tone: "thinking" | "tool" | "info" | "error";
      readonly sourceActivityKind: string;
      readonly detail?: string;
      readonly command?: string;
      readonly rawCommand?: string;
      readonly changedFiles?: ReadonlyArray<string>;
      readonly toolName?: string;
      readonly itemType?: string;
      readonly requestKind?: "command" | "file-read" | "file-change";
      readonly toolLifecycleStatus?: "inProgress" | "completed" | "failed" | "declined" | "stopped";
    };

export interface TimelineEntry {
  readonly itemKey: string;
  readonly seqStart: number;
  readonly seqEnd: number;
  readonly item: PresentationItem;
  readonly digest: string;
}

const LIFECYCLE: Readonly<Record<string, "completed" | "failed" | "declined" | "stopped">> = {
  completed: "completed",
  failed: "failed",
  declined: "declined",
  interrupted: "stopped",
  cancelled: "stopped",
  canceled: "stopped",
};

const TOOL_STATUS: Readonly<Record<string, "completed" | "failed" | "canceled">> = {
  completed: "completed",
  failed: "failed",
  declined: "failed",
  interrupted: "canceled",
  cancelled: "canceled",
  canceled: "canceled",
};

export const digestOf = (item: PresentationItem): string =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(item)).digest("hex");

const clip = (text: string, limit = DETAIL_CHARS) =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

/** A command's output: the item's text after its `$ command` line. */
function outputOf(text: string): string {
  const lines = text.split("\n");
  return (lines[0]?.startsWith("$ ") ? lines.slice(1) : lines).join("\n").trim();
}

/** File paths from a file change's text, one per line. */
function pathsOf(text: string): ReadonlyArray<string> {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.includes(" ") && line.length < 300)
    .slice(0, 50);
}

/** The step's label: its verb and what it acts on, such as "Searched the web for slack streams". */
function label(item: ActivityItem, open: boolean): string | undefined {
  const step = work(item);
  if (step === undefined) return undefined;
  const verb = open ? step.doing : step.done || step.doing;
  return oneLine(
    redactSecrets(step.parameter === "" ? verb : `${verb} ${step.parameter}`),
    LABEL_CHARS,
  );
}

function toolCall(item: ActivityItem, open: boolean): PresentationItem | undefined {
  const parsed = json(item);
  const name =
    typeof parsed?.toolName === "string"
      ? parsed.toolName
      : /"toolName":\s*"([^"]+)"/.exec(item.text ?? "")?.[1];
  if (name === undefined) return undefined;
  const base = {
    type: "tool_call" as const,
    callId: item.itemId,
    name,
    payloadEncoding: "json-v1" as const,
  };
  if (open) return { ...base, status: "running", inputJson: "{}" };
  const input = parsed === undefined ? (item.text ?? "") : JSON.stringify(parsed.input ?? null);
  const status = TOOL_STATUS[item.status] ?? "completed";
  const output =
    parsed === undefined
      ? undefined
      : JSON.stringify(redactSecrets(clip(JSON.stringify(parsed.output ?? parsed.result ?? null))));
  return {
    ...base,
    status,
    inputJson: JSON.stringify(redactSecrets(clip(input))),
    ...(output === undefined ? {} : { outputJson: output }),
    ...(status === "failed" ? { errorText: "The tool call failed." } : {}),
  };
}

/**
 * The item as an Office timeline item; nothing for items Office doesn't show,
 * such as the user's own message or T3's workspace setup. An assistant message
 * needs its whole text, so the caller passes it in once the message is done.
 */
export function presentationOf(
  item: ActivityItem,
  fullText?: string,
): PresentationItem | undefined {
  const open = isOpen(item.status);
  const lifecycle = open ? ("inProgress" as const) : (LIFECYCLE[item.status] ?? "completed");
  const text = item.text ?? "";
  switch (item.type) {
    case "reasoning":
      return { type: "reasoning" };
    case "assistant_message": {
      if (open || fullText === undefined || fullText.trim() === "") return undefined;
      return { type: "assistant_message", text: fullText, files: [] };
    }
    case "dynamic_tool":
      return toolCall(item, open);
    case "command_execution": {
      const step = work(item);
      if (step === undefined) return undefined;
      const command = oneLine(redactSecrets(step.parameter), LABEL_CHARS);
      const output = open ? "" : clip(redactSecrets(outputOf(text)));
      return {
        type: "work_log",
        label: label(item, open) ?? "Ran a command",
        tone: "tool",
        sourceActivityKind: "command_execution",
        ...(command === "" ? {} : { command, rawCommand: command }),
        ...(output === "" ? {} : { detail: output }),
        itemType: "command_execution",
        requestKind: "command",
        toolLifecycleStatus: lifecycle,
      };
    }
    case "file_change": {
      const files = open ? [] : pathsOf(text);
      return {
        type: "work_log",
        label: label(item, open) ?? "Edited files",
        tone: "tool",
        sourceActivityKind: "file_change",
        ...(files.length > 0 ? { changedFiles: files } : {}),
        itemType: "file_change",
        requestKind: "file-change",
        toolLifecycleStatus: lifecycle,
      };
    }
    case "web_search":
    case "file_search":
    case "subagent": {
      const line = label(item, open);
      if (line === undefined) return undefined;
      return {
        type: "work_log",
        label: line,
        tone: item.type === "subagent" ? "info" : "tool",
        sourceActivityKind: item.type,
        ...(item.type === "file_search" ? { requestKind: "file-read" as const } : {}),
        itemType: item.type,
        toolLifecycleStatus: lifecycle,
      };
    }
    case "todo_list":
      return {
        type: "work_log",
        label: "Updated the plan",
        tone: "info",
        sourceActivityKind: "todo_list",
        ...(open ? {} : { detail: clip(redactSecrets(text)) }),
        itemType: "todo_list",
      };
    case "user_input_request":
    case "approval_request":
      return {
        type: "work_log",
        label: item.type === "user_input_request" ? "Asked a question" : "Asked for permission",
        tone: "info",
        sourceActivityKind: item.type,
        ...(open || !item.title ? {} : { detail: clip(redactSecrets(item.title)) }),
        itemType: item.type,
      };
    default:
      return undefined;
  }
}

/** The timeline entry for an item, or nothing when Office doesn't show it. */
export function timelineEntry(item: ActivityItem, fullText?: string): TimelineEntry | undefined {
  const presented = presentationOf(item, fullText);
  if (presented === undefined) return undefined;
  const seqStart = item.position * 4;
  return {
    itemKey: item.itemId,
    seqStart,
    seqEnd: seqStart + (isOpen(item.status) ? 1 : 2),
    item: presented,
    digest: digestOf(presented),
  };
}
