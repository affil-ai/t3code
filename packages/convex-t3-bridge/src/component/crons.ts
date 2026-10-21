import { cronJobs } from "convex/server";
import { api } from "./_generated/api.js";

const crons = cronJobs();
crons.interval(
  "discover background turns and recover deliveries",
  { seconds: 5 },
  api.actions.sweep,
  {},
);
export default crons;
