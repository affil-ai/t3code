/**
 * A request to show one task's detail in the Tasks panel. The sidebar's
 * Planning cards set it as they open the coordinator chat and the panel;
 * the panel takes it once it is mounted beside that chat. Not persisted.
 */
import { create } from "zustand";

export interface FirstmateTaskFocusRequest {
  /** Scoped thread key of the coordinator chat whose panel should open the task. */
  readonly threadKey: string;
  readonly taskId: string;
}

interface FirstmateTaskFocusStore {
  request: FirstmateTaskFocusRequest | null;
  requestTask: (request: FirstmateTaskFocusRequest) => void;
  /** Returns and clears the request when it is for this chat; null otherwise. */
  take: (threadKey: string) => string | null;
}

export const useFirstmateTaskFocusStore = create<FirstmateTaskFocusStore>()((set, get) => ({
  request: null,
  requestTask: (request) => set({ request }),
  take: (threadKey) => {
    const { request } = get();
    if (request === null || request.threadKey !== threadKey) return null;
    set({ request: null });
    return request.taskId;
  },
}));
