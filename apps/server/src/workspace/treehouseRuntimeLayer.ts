import * as Layer from "effect/Layer";
import * as ProcessRunner from "../processRunner.ts";
import * as TreehouseWorktrees from "./TreehouseWorktrees.ts";

/** One pool controller for allocation, resumption, and cleanup. */
export const layer = TreehouseWorktrees.layer.pipe(Layer.provide(ProcessRunner.layer));
