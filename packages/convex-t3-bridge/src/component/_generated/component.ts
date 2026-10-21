import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import type { api } from "./api.js";

// The installed component API exposes public functions as internal references.
type Installed<T> = {
  [K in keyof T]: T[K] extends FunctionReference<infer Kind, "public">
    ? FunctionReference<Kind, "internal", FunctionArgs<T[K]>, FunctionReturnType<T[K]>>
    : Installed<T[K]>;
};
export type ComponentApi = Installed<typeof api>;
