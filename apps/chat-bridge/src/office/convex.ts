/**
 * Office's agent-host functions, called over Convex's public HTTP API
 * (`/api/query` and `/api/mutation`) with the worker service token. The
 * shapes below are the parts of Office's contract the bridge reads, from
 * `apps/office/convex/agentHost.ts` and `model/chat/agentHost/outbound.ts`.
 */

export interface OfficeModelSelection {
  readonly instanceId: string;
  readonly model?: string | undefined;
  readonly options?: unknown;
}

export interface OfficeFile {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly downloadUrl: string;
}

/** A queued run Office wants started: a new chat (`provision`) or a follow-up (`dispatch`). */
export interface WorkRef {
  readonly runId: string;
  readonly bindingId: string;
  readonly receiptId: string;
  readonly threadId?: string | undefined;
}

export interface PendingWork {
  readonly provisions: ReadonlyArray<WorkRef>;
  readonly dispatches: ReadonlyArray<WorkRef>;
  readonly cancels: ReadonlyArray<{
    readonly runId: string;
    readonly bindingId: string;
    readonly threadId: string;
    readonly providerTurnId: string;
  }>;
  readonly subscriptions: ReadonlyArray<{
    readonly bindingId: string;
    readonly threadId: string;
    readonly activeProviderTurnIds: ReadonlyArray<string>;
  }>;
}

export interface Claim {
  readonly kind: "provision" | "dispatch";
  readonly runId: string;
  readonly bindingId: string;
  readonly receiptId: string;
  readonly attempt: number;
  readonly commandGeneration?: number | undefined;
  readonly threadId?: string | undefined;
  readonly title?: string | undefined;
  readonly actor: {
    readonly externalUserId: string;
    readonly displayName: string;
    readonly email: string;
  };
  readonly message: { readonly markdown: string; readonly files: ReadonlyArray<OfficeFile> };
  readonly sourceUrls?: { readonly officeChat: string; readonly slackThread?: string } | undefined;
  readonly initialContext?:
    | { readonly downloadUrl: string; readonly files?: ReadonlyArray<OfficeFile> | undefined }
    | undefined;
  readonly modelSelection?: OfficeModelSelection | undefined;
  readonly workspaceMode?: "local" | undefined;
}

/** One `postEvents` result; Office applies each event on its own. */
export interface EventOutcome {
  readonly outcome: "applied" | "duplicate" | "stale" | "updated";
}

export class OfficeConvexError extends Error {
  readonly data: unknown;
  constructor(path: string, message: string, data: unknown) {
    super(`${path}: ${message}`);
    this.data = data;
  }
}

export interface OfficeApi {
  pendingWork(environmentId: string): Promise<PendingWork>;
  claimWork(run: WorkRef, kind: Claim["kind"], environmentId: string): Promise<Claim | null>;
  reportPreDispatchFailure(input: {
    readonly runId: string;
    readonly kind: Claim["kind"];
    readonly attempt: number;
    readonly environmentId: string;
    readonly errorCode: string;
    readonly errorMessage: string;
    readonly terminal: boolean;
  }): Promise<string>;
  postEvents(events: ReadonlyArray<Record<string, unknown>>): Promise<ReadonlyArray<EventOutcome>>;
}

/** Office over HTTP. The token never leaves the request body. */
export class OfficeConvex implements OfficeApi {
  private readonly url: string;
  private readonly serviceToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(url: string, serviceToken: string, fetchImpl: typeof fetch = fetch) {
    this.url = url.replace(/\/+$/, "");
    this.serviceToken = serviceToken;
    this.fetchImpl = fetchImpl;
  }

  private async call<T>(
    kind: "query" | "mutation",
    path: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.url}/api/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        path,
        args: { ...args, serviceToken: this.serviceToken },
        format: "json",
      }),
    });
    const body = (await response.json().catch(() => undefined)) as
      | { status: "success"; value: T }
      | { status: "error"; errorMessage: string; errorData?: unknown }
      | undefined;
    if (body?.status === "success") return body.value;
    throw new OfficeConvexError(
      path,
      body?.status === "error" ? body.errorMessage : `HTTP ${response.status}`,
      body?.status === "error" ? body.errorData : undefined,
    );
  }

  pendingWork(environmentId: string): Promise<PendingWork> {
    return this.call("query", "agentHost:pendingWork", { environmentId });
  }

  claimWork(run: WorkRef, kind: Claim["kind"], environmentId: string): Promise<Claim | null> {
    return this.call("mutation", "agentHost:claimWork", { runId: run.runId, kind, environmentId });
  }

  reportPreDispatchFailure(input: Parameters<OfficeApi["reportPreDispatchFailure"]>[0]) {
    return this.call<string>("mutation", "agentHost:reportPreDispatchFailure", { ...input });
  }

  postEvents(events: ReadonlyArray<Record<string, unknown>>) {
    return this.call<ReadonlyArray<EventOutcome>>("mutation", "agentHost:postEvents", { events });
  }
}
