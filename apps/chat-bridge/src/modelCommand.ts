/**
 * Office's model switch (`!opus`, `!sol-high`, `!high`), anywhere in a message.
 * A thread can change provider: GPT models run on Codex, every other model on Claude.
 */

/** A T3 model selection, as `t3_thread_launch` and `t3_thread_configure` take it. */
export interface ModelSelection {
  readonly instanceId: string;
  readonly model: string;
  readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
}

interface ModelEntry {
  readonly instanceId: string;
  readonly model: string;
  readonly label: string;
  /** The effort it starts at; absent for a model without an effort setting. */
  readonly effort?: string;
}

/** The names people type, and the effort each starts at. */
export const MODELS: Readonly<Record<string, ModelEntry>> = {
  opus: {
    instanceId: "claudeAgent",
    model: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    effort: "medium",
  },
  fable: {
    instanceId: "claudeAgent",
    model: "claude-fable-5-1",
    label: "Claude Fable 5.1",
    effort: "medium",
  },
  astra: { instanceId: "codex", model: "gpt-6-astra", label: "GPT-6 Astra", effort: "medium" },
  sol: { instanceId: "codex", model: "gpt-6.1-sol", label: "GPT-6.1 Sol", effort: "high" },
  terra: { instanceId: "codex", model: "gpt-6.1-terra", label: "GPT-6.1 Terra", effort: "high" },
  glm: { instanceId: "claudeAgent", model: "z-ai/glm-5.3", label: "GLM 5.3" },
};

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Each provider names its effort option differently. */
const EFFORT_OPTION: Readonly<Record<string, string>> = {
  claudeAgent: "effort",
  codex: "reasoningEffort",
};

export interface ModelCommand {
  /** A key of `MODELS`; absent when only the effort changes. */
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  /** As typed, for messages. */
  readonly typed: string;
}

const COMMAND = /(?<!\S)!([A-Za-z]+)(?:-([A-Za-z]+))?(?=\s|$)/g;

const isEffort = (word: string) => (EFFORTS as ReadonlyArray<string>).includes(word);

/** True when `index` falls inside inline or fenced code. */
function insideCode(text: string, index: number): boolean {
  const before = text.slice(0, index);
  const fences = before.split("```").length - 1;
  if (fences % 2 === 1) return true;
  const lastLine = before.slice(before.lastIndexOf("\n") + 1);
  return (lastLine.split("`").length - 1) % 2 === 1;
}

/** Takes the first model switch out of the text. Unknown `!words` stay as written. */
export function parseModelCommand(text: string): {
  readonly text: string;
  readonly command?: ModelCommand;
} {
  for (const match of text.matchAll(COMMAND)) {
    const word = match[1]!.toLowerCase();
    const suffix = match[2]?.toLowerCase();
    const known =
      word in MODELS ? suffix === undefined || isEffort(suffix) : !suffix && isEffort(word);
    if (!known || insideCode(text, match.index)) continue;
    const before = text.slice(0, match.index).replace(/[^\S\r\n]+$/, "");
    const after = text.slice(match.index + match[0].length).replace(/^[^\S\r\n]+/, "");
    const joined = before && after && !/\n$/.test(before) && !/^\n/.test(after) ? " " : "";
    return {
      text: (before + joined + after).trim(),
      command:
        word in MODELS
          ? { model: word, effort: suffix, typed: match[0] }
          : { effort: word, typed: match[0] },
    };
  }
  return { text };
}

/** The effort a selection runs at, if it names one. */
export function effortOf(selection: ModelSelection): string | undefined {
  const id = EFFORT_OPTION[selection.instanceId];
  const value = selection.options?.find((option) => option.id === id)?.value;
  return typeof value === "string" ? value : undefined;
}

function withEffort(instanceId: string, model: string, effort: string | undefined): ModelSelection {
  const id = EFFORT_OPTION[instanceId];
  return {
    instanceId,
    model,
    ...(effort === undefined || id === undefined ? {} : { options: [{ id, value: effort }] }),
  };
}

const entryFor = (selection: ModelSelection) =>
  Object.values(MODELS).find(
    (entry) => entry.instanceId === selection.instanceId && entry.model === selection.model,
  );

/** How a selection reads in a message, such as "Claude Opus 5.5, medium effort". */
export function describeModel(selection: ModelSelection): string {
  const name = entryFor(selection)?.label ?? selection.model;
  const effort = effortOf(selection);
  return effort === undefined ? name : `${name}, ${effort} effort`;
}

/** The selection a switch asks for, from the thread's current one. */
export function resolveModelCommand(
  command: ModelCommand,
  current: ModelSelection,
): { readonly selection: ModelSelection } | { readonly error: string } {
  const entry = command.model === undefined ? entryFor(current) : MODELS[command.model]!;
  const instanceId = entry?.instanceId ?? current.instanceId;
  const model = entry?.model ?? current.model;
  if (command.effort !== undefined && entry !== undefined && entry.effort === undefined) {
    return { error: `${entry.label} has no effort setting.` };
  }
  return { selection: withEffort(instanceId, model, command.effort ?? entry?.effort) };
}
