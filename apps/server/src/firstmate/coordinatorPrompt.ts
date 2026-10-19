/**
 * The first message of a new coordinator chat. The standing instructions live
 * in the home folder's `AGENTS.md` (see `homeFiles.ts`), which the provider
 * harness loads on its own; this only points at them.
 */
export const coordinatorKickoff = (name: string) =>
  `You are ${name}. Your instructions are in AGENTS.md in this folder; read them and notes/ before anything else, then greet the user briefly.`;
