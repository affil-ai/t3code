import { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { FirstmatePage } from "../components/firstmate/FirstmatePage";

function FirstmateRouteView() {
  const { environmentId } = Route.useParams();
  return <FirstmatePage environmentId={EnvironmentId.make(environmentId)} />;
}

export const Route = createFileRoute("/_chat/firstmate/$environmentId")({
  component: FirstmateRouteView,
});
