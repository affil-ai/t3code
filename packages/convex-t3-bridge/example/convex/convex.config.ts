import { defineApp } from "convex/server";
import t3Bridge from "../../src/component/convex.config.js";

const app = defineApp();
app.use(t3Bridge);
export default app;
