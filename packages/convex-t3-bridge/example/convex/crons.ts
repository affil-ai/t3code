import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();
crons.interval("poll Slack test channel", { seconds: 3 }, internal.slack.poll, {});
export default crons;
