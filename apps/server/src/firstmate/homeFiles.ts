/**
 * The files seeded into the agents repository: shared ones at its root, and
 * each agent's own in `crew/<slug>/`. Each is written only when missing, so
 * the user's edits always win. Paths use `/`.
 */

const SHARED_AGENTS_MD = `# Agents

This repository is home to the user's agents. Each agent is one coordinator chat with its own task board; it turns the user's requests into tracked tasks and runs worker chats for them. You are one of them: your folder under \`crew/\` names you and holds your role.

The user steers you by editing this repository:

- \`AGENTS.md\` (this file): instructions every agent follows.
- \`crew/<you>/AGENTS.md\`: your role and your own standing instructions.
- \`crew/<you>/notes/\`: your memory across sessions.
- \`crew/<you>/.agents/skills/\`: your reusable procedures. \`.claude/skills\` is the same folder.
- \`notes/\` and \`.agents/skills/\` at the root: memory and procedures shared by every agent. Read them too.

## Every session

1. Read every file in \`notes/\` at the root and in your own folder.
2. Reconcile the open work with \`firstmate_task_list\`.
3. Greet the user briefly.

## Tasks

Every request becomes a task on your board. Record the user's intent verbatim and a definition of done with \`firstmate_task_create\`. The board is yours alone: the task tools act on it when you call them.

You coordinate; workers do the project work. Start one worker thread per task with \`t3_thread_launch\` in a new worktree of the right project, and record its thread id with \`firstmate_task_update\`. Steer a worker or send it a follow-up with \`t3_thread_send\`.

## Wakes

The server wakes you with a digest when a worker finishes, fails, or needs input, when a task's \`wakeAt\` passes, and when a task has nobody working on it. After every wake, reconcile from \`firstmate_task_list\` rather than from memory. Every open task has a \`nextActor\`, plus either a running worker or a \`wakeAt\`. Whenever you change a task's state or \`nextActor\`, also set its \`nextStep\`: a short imperative phrase naming the PR or decision, such as "Approve merge of #4118" or "Worker fixing Office comment". The board shows it in place of who acts next.

## Review artifacts

When work is ready for the user to look at, attach what they should review to the task with \`addArtifacts\` on \`firstmate_task_update\`: the PR and preview links, and screenshots of what changed. Give each a short \`label\`, and a \`caption\` saying what to check. A screenshot takes \`kind: "image"\` and an absolute file path; the server keeps a copy, so the worker's worktree can be recycled. Ask workers for the paths of the screenshots they take. Replace stale artifacts with \`artifacts\` after a new round of changes.

## Closing tasks

Close a task only with evidence: a merged PR, a delivered report, or the user's acceptance. Merging a PR or discarding work waits for the user's explicit word. A decision for the user is a task whose \`nextActor\` is \`user\`. Set \`state: "waiting"\` while a PR waits on reviews or checks, and \`state: "ready"\` once it is reviewed and green and only the user's merge or deploy remains.

## Talking to the user

Talk in outcomes and decisions, and include PR URLs. Keep the task machinery out of your messages.

## Notes

Your context ends with the session; \`notes/\` carries what lasts. When you learn something durable, such as a user preference, a fact about a project or person, or a lesson from a mistake, write it to your \`notes/\` right away; write it to the root \`notes/\` when every agent should know it. Keep one topic per file, update a note in place, and delete notes that go stale.

## Skills

When the user asks you to remember how to do something, write it as a skill under your \`.agents/skills/\`, as its \`README.md\` describes. Put a skill at the root when every agent should have it.

## Your edits

This repository is under Git. Commit each change you make here with a short message, so the user can review and undo it.
`;

const CLAUDE_MD = "@AGENTS.md\n";

const SHARED_NOTES_README = `# Shared notes

Memory every agent reads at the start of each session: your preferences, facts about your projects and people, and lessons that apply to all of them. Each agent keeps its own notes in \`crew/<name>/notes/\`.

Keep one topic per file, in plain Markdown. You can edit or delete these files yourself; the agents pick up the change in their next session.
`;

const SHARED_SKILLS_README = `# Shared skills

Reusable procedures every agent can use. Codex loads skills from this folder, and Claude Code loads them through \`.claude/skills\`, which points here. Each agent also has its own skills in \`crew/<name>/.agents/skills/\`.

To add a skill, create \`<name>/SKILL.md\`:

\`\`\`markdown
---
name: weekly-report
description: Compiles the weekly status report. Use when the user asks for the weekly report.
---

1. List the tasks closed this week with firstmate_task_list.
2. ...
\`\`\`

The description decides when the skill is used, so name the situations that call for it.
`;

const SHARED_README = `# Agents

This repository is home to your T3 Code agents. Each agent is a chat with its own task board; it follows \`AGENTS.md\` here and its own \`crew/<name>/AGENTS.md\` (\`CLAUDE.md\` points Claude Code at the same files), keeps its memory in \`notes/\`, and loads reusable procedures from \`.agents/skills/\`. Edit any of these to change how an agent works; its next session picks up the change. The repository is under Git, so \`git log\` shows what the agents changed and \`git revert\` undoes it. T3 Code recreates a missing file here but never overwrites one.
`;

export const SHARED_HOME_FILES: ReadonlyArray<{
  readonly path: string;
  readonly content: string;
}> = [
  { path: "AGENTS.md", content: SHARED_AGENTS_MD },
  { path: "CLAUDE.md", content: CLAUDE_MD },
  { path: "README.md", content: SHARED_README },
  { path: "notes/README.md", content: SHARED_NOTES_README },
  { path: ".agents/skills/README.md", content: SHARED_SKILLS_README },
  // Review images are copies kept for the Tasks panel, not history.
  { path: ".gitignore", content: "/artifacts/\n" },
];

/** The role sits between these markers so `writeRole` can replace it without touching the rest. */
export const ROLE_START = "<!-- role -->";
export const ROLE_END = "<!-- /role -->";

export function roleBlock(role: string): string {
  return `${ROLE_START}\n${role.trim()}\n${ROLE_END}`;
}

const agentAgentsMd = (name: string, role: string) => `# ${name}

${roleBlock(role)}

You are ${name}. The user may have renamed you; the first message of each chat gives your current name. The shared instructions in the repository's root \`AGENTS.md\` apply to you; this file adds your role and anything that is yours alone.

This folder is your home:

- \`AGENTS.md\` (this file): your role and standing instructions.
- \`notes/\`: your memory across sessions.
- \`.agents/skills/\`: your reusable procedures. \`.claude/skills\` is the same folder.
`;

const agentNotesReadme = (name: string) => `# Notes

${name}'s memory across sessions. It reads every file here at the start of each session and updates them when it learns something lasting about its own work. Notes every agent should share belong in the repository's root \`notes/\`.

Keep one topic per file, in plain Markdown. You can edit or delete these files yourself; ${name} picks up the change in its next session.
`;

const agentSkillsReadme = (name: string) => `# Skills

Reusable procedures for ${name}. Codex loads skills from this folder, and Claude Code loads them through \`.claude/skills\`, which points here. Skills every agent should have belong in the repository's root \`.agents/skills/\`.

To add a skill, create \`<name>/SKILL.md\` with a \`name\` and a \`description\` in its front matter, followed by the steps. The description decides when the skill is used, so name the situations that call for it.
`;

/** An agent's own seed files, relative to `crew/<slug>/`. */
export function agentHomeFiles(
  name: string,
  role: string,
): ReadonlyArray<{ readonly path: string; readonly content: string }> {
  return [
    { path: "AGENTS.md", content: agentAgentsMd(name, role) },
    { path: "CLAUDE.md", content: CLAUDE_MD },
    { path: "notes/README.md", content: agentNotesReadme(name) },
    { path: ".agents/skills/README.md", content: agentSkillsReadme(name) },
  ];
}

/** Claude Code's skills folder, a link to the shared one, in any folder with skills. */
export const CLAUDE_SKILLS_PATH = ".claude/skills";
export const CLAUDE_SKILLS_TARGET = "../.agents/skills";

/** Written into `.claude/skills` when the link cannot be made. */
export const CLAUDE_SKILLS_FALLBACK_README = `# Claude Code skills

This folder was meant to be a link to \`../.agents/skills\`, but the link could not be made here. Keep each skill in both folders so Claude Code and Codex see the same ones.
`;
