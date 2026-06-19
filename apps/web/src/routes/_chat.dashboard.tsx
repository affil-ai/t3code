import { createFileRoute } from "@tanstack/react-router";

import { DashboardIssuesView } from "../components/dashboard/DashboardIssuesView";

export const Route = createFileRoute("/_chat/dashboard")({
  component: DashboardIssuesView,
});
