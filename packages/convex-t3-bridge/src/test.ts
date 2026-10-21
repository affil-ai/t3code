/// <reference types="vite/client" />
import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import schema from "./component/schema.js";
import type { ComponentApi } from "./component/_generated/component.js";

export const modules = import.meta.glob("./component/**/*.ts");
export function register<Schema extends SchemaDefinition<GenericSchema, boolean>>(
  t: TestConvex<Schema>,
  name = "t3Bridge",
) {
  return t.registerComponent<ComponentApi>(name, schema, modules);
}
export default { register, schema, modules };
