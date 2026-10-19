import { environmentEndpointUrl } from "@t3tools/client-runtime/environment";
import * as Option from "effect/Option";
import { useEffect, useMemo } from "react";
import type { EnvironmentId } from "@t3tools/contracts";

import { readPreparedConnection } from "../../state/session";
import {
  useConnectedEnvironmentIds,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { useWorkModeStore, pickWorkSharedData, type WorkSharedData } from "../../workModeStore";
import {
  decideWorkStateMigration,
  rebaseWorkState,
  sharedDataFromWorkState,
  type WorkStateResponse,
} from "./workStateSync.logic";

const WORK_STATE_PATH = "/api/t3work/state";
const WORK_STATE_SYNC_STORAGE_KEY = "t3work:work-state-sync:v1";
const SYNC_INTERVAL_MS = 60_000;
const PUSH_DEBOUNCE_MS = 500;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_CONFLICT_RETRIES = 3;

interface SyncTargetRecord {
  readonly lastVersion: number;
}

type SyncTargetRecords = Record<string, SyncTargetRecord>;

function readSyncTargetRecords(): SyncTargetRecords {
  if (typeof window === "undefined") return {};
  const raw = window.localStorage.getItem(WORK_STATE_SYNC_STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, SyncTargetRecord] =>
          !!entry[1] &&
          typeof entry[1] === "object" &&
          typeof (entry[1] as { lastVersion?: unknown }).lastVersion === "number" &&
          Number.isInteger((entry[1] as { lastVersion: number }).lastVersion) &&
          (entry[1] as { lastVersion: number }).lastVersion >= 0,
      ),
    );
  } catch {
    return {};
  }
}

function rememberSyncTarget(endpoint: string, version: number): void {
  if (typeof window === "undefined") return;
  const records = readSyncTargetRecords();
  records[endpoint] = { lastVersion: version };
  window.localStorage.setItem(WORK_STATE_SYNC_STORAGE_KEY, JSON.stringify(records));
}

function parseStateResponse(value: unknown): WorkStateResponse | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { format?: unknown; version?: unknown; data?: unknown };
  if (
    raw.format !== "t3work-state/1" ||
    typeof raw.version !== "number" ||
    !Number.isInteger(raw.version) ||
    raw.version < 0 ||
    !("data" in raw)
  ) {
    return null;
  }
  return {
    format: "t3work-state/1",
    version: raw.version,
    data: raw.data === null ? null : raw.data,
  };
}

async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<{ response: Response; body: unknown | null } | null> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    let body: unknown | null = null;
    try {
      body = await response.json();
    } catch {
      // The stock T3 server returns HTML or a 404 for this optional endpoint.
    }
    return { response, body };
  } catch (error) {
    console.debug("T3 Work state sync request failed.", url, error);
    return null;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

async function readWorkState(endpoint: string): Promise<WorkStateResponse | null> {
  const result = await fetchJson(endpoint);
  if (result === null || !result.response.ok) return null;
  return parseStateResponse(result.body);
}

async function writeWorkState(
  endpoint: string,
  baseVersion: number,
  data: WorkSharedData,
): Promise<
  | { readonly kind: "success"; readonly state: WorkStateResponse }
  | { readonly kind: "conflict"; readonly state: WorkStateResponse }
  | null
> {
  const result = await fetchJson(endpoint, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseVersion, data }),
  });
  if (result === null) return null;
  const state = parseStateResponse(result.body);
  if (state === null) return null;
  if (result.response.status === 409) return { kind: "conflict", state };
  if (!result.response.ok) return null;
  return { kind: "success", state };
}

function httpBaseUrlForEnvironment(
  environment: ReturnType<typeof useEnvironments>["environments"][number],
): string | null {
  const prepared = readPreparedConnection(environment.environmentId);
  if (prepared !== null) return prepared.httpBaseUrl;
  if (environment.entry.target._tag === "PrimaryConnectionTarget") {
    return environment.entry.target.httpBaseUrl;
  }
  const profile = Option.getOrNull(environment.entry.profile);
  return profile !== null && "httpBaseUrl" in profile ? profile.httpBaseUrl : null;
}

function orderedConnectedHttpBaseUrls(input: {
  readonly environments: ReturnType<typeof useEnvironments>["environments"];
  readonly connectedEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): string[] {
  const connected = new Set(input.connectedEnvironmentIds);
  const byId = new Map(
    input.environments.map((environment) => [environment.environmentId, environment]),
  );
  const orderedIds = [
    ...(input.primaryEnvironmentId !== null ? [input.primaryEnvironmentId] : []),
    ...input.environments
      .map((environment) => environment.environmentId)
      .filter((environmentId) => environmentId !== input.primaryEnvironmentId),
  ];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const environmentId of orderedIds) {
    if (!connected.has(environmentId)) continue;
    const environment = byId.get(environmentId);
    if (!environment) continue;
    const httpBaseUrl = httpBaseUrlForEnvironment(environment);
    if (httpBaseUrl !== null && !seen.has(httpBaseUrl)) {
      seen.add(httpBaseUrl);
      urls.push(httpBaseUrl);
    }
  }
  return urls;
}

async function discoverTarget(httpBaseUrls: ReadonlyArray<string>): Promise<{
  readonly endpoint: string;
  readonly state: WorkStateResponse;
} | null> {
  for (const httpBaseUrl of httpBaseUrls) {
    const endpoint = environmentEndpointUrl(httpBaseUrl, WORK_STATE_PATH);
    const state = await readWorkState(endpoint);
    if (state !== null) return { endpoint, state };
  }
  console.debug("No connected T3 environment serves the optional Work state endpoint.");
  return null;
}

function applyServerDataToStore(value: unknown): void {
  useWorkModeStore.getState().applyServerData(value);
}

async function pushPendingOperations(
  endpoint: string,
  initialState: WorkStateResponse,
): Promise<void> {
  let baseVersion = initialState.version;
  let data = sharedDataFromWorkState(useWorkModeStore.getState());

  for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt += 1) {
    const storeBeforeRequest = useWorkModeStore.getState();
    const operationsBeforeRequest = storeBeforeRequest.pendingOperations;
    data = sharedDataFromWorkState(storeBeforeRequest);
    const result = await writeWorkState(endpoint, baseVersion, data);
    if (result === null) return;
    if (result.kind === "success") {
      useWorkModeStore.getState().acknowledgePendingOperations(operationsBeforeRequest.length);
      rememberSyncTarget(endpoint, result.state.version);
      return;
    }

    const store = useWorkModeStore.getState();
    const rebased = rebaseWorkState(store, result.state.data, store.pendingOperations);
    store.applyServerData(pickWorkSharedData(rebased));
    baseVersion = result.state.version;
    data = sharedDataFromWorkState(rebased);
  }

  console.debug("T3 Work state sync stopped after repeated version conflicts.");
}

async function synchronizeTarget(endpoint: string, state: WorkStateResponse): Promise<void> {
  const records = readSyncTargetRecords();
  const targetRecord = records[endpoint];
  const hasSynced = targetRecord !== undefined;
  const store = useWorkModeStore.getState();
  const pendingOperations = store.pendingOperations;
  const localData = sharedDataFromWorkState(store);

  if (!hasSynced) {
    const decision = decideWorkStateMigration({
      serverVersion: state.version,
      serverData: state.data,
      localData,
      hasSynced: false,
    });
    if (decision === "apply-server") {
      applyServerDataToStore(state.data);
      // A first-seen non-empty server is authoritative; do not merge edits
      // that were made before this target was discovered.
      if (pendingOperations.length > 0) {
        useWorkModeStore.getState().acknowledgePendingOperations(pendingOperations.length);
      }
      rememberSyncTarget(endpoint, state.version);
      return;
    }
    await pushPendingOperations(endpoint, state);
    return;
  }

  if (pendingOperations.length > 0) {
    // Keep local state intact while there are unsent operations. A 409 below
    // rebases these reducer calls onto the server snapshot.
    await pushPendingOperations(endpoint, state);
    return;
  }

  if (state.version > targetRecord.lastVersion) {
    applyServerDataToStore(state.data);
    rememberSyncTarget(endpoint, state.version);
  }
}

export function useWorkStateSync(): void {
  const { environments } = useEnvironments();
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentInputs = useMemo(
    () => ({ environments, connectedEnvironmentIds, primaryEnvironmentId }),
    [environments, connectedEnvironmentIds, primaryEnvironmentId],
  );
  useEffect(() => {
    const httpBaseUrls = orderedConnectedHttpBaseUrls(environmentInputs);
    if (httpBaseUrls.length === 0) return;
    let disposed = false;
    let running = false;
    let rerun = false;
    let pushTimer: ReturnType<typeof setTimeout> | undefined;

    const synchronize = async () => {
      if (disposed) return;
      if (running) {
        rerun = true;
        return;
      }
      running = true;
      try {
        const discovered = await discoverTarget(httpBaseUrls);
        if (!disposed && discovered !== null) {
          await synchronizeTarget(discovered.endpoint, discovered.state);
        }
      } catch (error) {
        console.debug("T3 Work state sync failed.", error);
      } finally {
        running = false;
        if (rerun && !disposed) {
          rerun = false;
          void synchronize();
        }
      }
    };

    const schedulePush = () => {
      if (pushTimer !== undefined) globalThis.clearTimeout(pushTimer);
      pushTimer = globalThis.setTimeout(() => {
        pushTimer = undefined;
        void synchronize();
      }, PUSH_DEBOUNCE_MS);
    };
    const unsubscribe = useWorkModeStore.subscribe((state, previous) => {
      if (state.pendingOperations.length > previous.pendingOperations.length) schedulePush();
    });

    let interval: ReturnType<typeof setInterval> | undefined;
    const startInterval = () => {
      if (interval === undefined) {
        interval = globalThis.setInterval(() => void synchronize(), SYNC_INTERVAL_MS);
      }
    };
    const stopInterval = () => {
      if (interval !== undefined) {
        globalThis.clearInterval(interval);
        interval = undefined;
      }
    };
    const onFocus = () => {
      if (document.visibilityState === "visible") void synchronize();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        startInterval();
        void synchronize();
      } else {
        stopInterval();
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);

    void synchronize();
    if (document.visibilityState === "visible") startInterval();

    return () => {
      disposed = true;
      unsubscribe();
      if (pushTimer !== undefined) globalThis.clearTimeout(pushTimer);
      stopInterval();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [environmentInputs]);
}
