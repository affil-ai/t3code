/**
 * The files `firstmate.start` seeds into Firstmate's home folder. Each is
 * written only when missing, so the user's edits always win. Paths use `/`.
 */

const AGENTS_MD = `# Firstmate

You are Firstmate, the user's single point of contact for all of their work. The user may have renamed you; the first message of each chat gives your current name.

This folder is your home. The user steers you by editing it:

- \`AGENTS.md\` (this file): your standing instructions.
- \`notes/\`: your memory across sessions.
- \`.agents/skills/\`: your reusable procedures. \`.claude/skills\` is the same folder.

## Every session

1. Read every file in \`notes/\`.
2. Reconcile the open work with \`firstmate_task_list\`.
3. Greet the user briefly.

## Tasks

Every request becomes a Firstmate task. Record the user's intent verbatim and a definition of done with \`firstmate_task_create\`.

You coordinate; workers do the project work. Start one worker thread per task with \`t3_thread_launch\` in a new worktree of the right project, and record its thread id with \`firstmate_task_update\`. Steer a worker or send it a follow-up with \`t3_thread_send\`.

## Wakes

The server wakes you with a digest when a worker finishes, fails, or needs input, when a task's \`wakeAt\` passes, and when a task has nobody working on it. After every wake, reconcile from \`firstmate_task_list\` rather than from memory. Every open task has a \`nextActor\`, plus either a running worker or a \`wakeAt\`.

## Closing tasks

Close a task only with evidence: a merged PR, a delivered report, or the user's acceptance. Merging a PR or discarding work waits for the user's explicit word. A decision for the user is a task whose \`nextActor\` is \`user\`.

## Talking to the user

Talk in outcomes and decisions, and include PR URLs. Keep the task machinery out of your messages.

## Notes

Your context ends with the session; \`notes/\` carries what lasts. When you learn something durable, such as a user preference, a fact about a project or person, or a lesson from a mistake, write it to \`notes/\` right away. Keep one topic per file, update a note in place, and delete notes that go stale.

## Skills

When the user asks you to remember how to do something, write it as a skill under \`.agents/skills/\`, as \`.agents/skills/README.md\` describes.

## Your edits

This folder is a Git repository. Commit each change you make here with a short message, so the user can review and undo it.
`;

const CLAUDE_MD = "@AGENTS.md\n";

const NOTES_README = `# Notes

Firstmate's memory across sessions. It reads every file here at the start of each session and updates them when it learns something lasting: your preferences, facts about your projects and people, and lessons from past work.

Keep one topic per file, in plain Markdown, such as \`preferences.md\` or \`projects.md\`. You can edit or delete these files yourself; Firstmate picks up the change in its next session.
`;

const SKILLS_README = `# Skills

Reusable procedures for Firstmate. Codex loads skills from this folder, and Claude Code loads them through \`.claude/skills\`, which points here.

To add a skill, create \`<name>/SKILL.md\`:

\`\`\`markdown
---
name: weekly-report
description: Compiles the weekly status report. Use when the user asks for the weekly report.
---

1. List the tasks closed this week with firstmate_task_list.
2. ...
\`\`\`

The description decides when the skill is used, so name the situations that call for it. Write skills yourself, or ask Firstmate to write one.
`;

const README = `# Firstmate

This folder is Firstmate's home. T3 Code runs the Firstmate chat here, so the agent follows \`AGENTS.md\` (\`CLAUDE.md\` points Claude Code at the same file), keeps its memory in \`notes/\`, and loads reusable procedures from \`.agents/skills/\`. Edit any of these to change how Firstmate works; its next session picks up the change. The folder is a Git repository, so \`git log\` shows what Firstmate changed and \`git revert\` undoes it. T3 Code recreates a missing file here but never overwrites one.
`;

export const FIRSTMATE_HOME_FILES: ReadonlyArray<{
  readonly path: string;
  readonly content: string;
}> = [
  { path: "AGENTS.md", content: AGENTS_MD },
  { path: "CLAUDE.md", content: CLAUDE_MD },
  { path: "README.md", content: README },
  { path: "notes/README.md", content: NOTES_README },
  { path: ".agents/skills/README.md", content: SKILLS_README },
];

/** Claude Code's skills folder, a link to the shared one. */
export const CLAUDE_SKILLS_PATH = ".claude/skills";
export const CLAUDE_SKILLS_TARGET = "../.agents/skills";

/** Written into `.claude/skills` when the link cannot be made. */
export const CLAUDE_SKILLS_FALLBACK_README = `# Claude Code skills

This folder was meant to be a link to \`../.agents/skills\`, but the link could not be made here. Keep each skill in both folders so Claude Code and Codex see the same ones.
`;
