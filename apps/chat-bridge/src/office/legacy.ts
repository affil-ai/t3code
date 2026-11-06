import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

export interface LegacyBinding {
  kind: "office" | "slack" | "support";
  chatId: string;
  threadId: string;
  environmentId?: string;
  slackKey?: string;
  sync: boolean;
}

export interface LegacyPage {
  page: LegacyBinding[];
  cursor: string | null;
  isDone: boolean;
  counts?: { seen: number; exported: number; skipped: Record<string, number> };
}

export interface OfficeExport {
  legacyBindings(cursor: string | null): Promise<LegacyPage>;
}

export class OfficeExportClient implements OfficeExport {
  private readonly client: ConvexHttpClient;
  private readonly token: string;

  constructor(url: string, token: string) {
    this.client = new ConvexHttpClient(url, { logger: false });
    this.token = token;
  }

  async legacyBindings(cursor: string | null): Promise<LegacyPage> {
    try {
      return await this.client.query(
        makeFunctionReference<
          "query",
          { serviceToken: string; cursor: string | null; limit: number },
          LegacyPage
        >("chatBridge:legacyBindings"),
        { serviceToken: this.token, cursor, limit: 100 },
      );
    } catch {
      // Convex errors can contain arguments, including the service token.
      throw new Error("Office legacyBindings failed. Check the deployment and service token.");
    }
  }
}
