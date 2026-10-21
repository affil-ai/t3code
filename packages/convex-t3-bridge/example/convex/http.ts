import { httpRouter } from "convex/server";
import { t3 } from "./t3.js";

const http = httpRouter();
t3.registerReplyRoute(http, {
  path: "/t3-reply",
  authorize: (request) => {
    const token = process.env.T3_BRIDGE_MCP_TOKEN;
    return Boolean(token) && request.headers.get("authorization") === `Bearer ${token}`;
  },
});
export default http;
