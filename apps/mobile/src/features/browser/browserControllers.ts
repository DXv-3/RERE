// Where the agent host and the Browser screen find a tab's WebView. Kept apart from the WebView
// layer so actions can reach a tab without importing the component that renders it.

/** A failure the page or the WebView reports, tagged with the error the server understands. */
export class BrowserHostError extends Error {
  constructor(
    readonly cwTag: string,
    message: string,
  ) {
    super(message);
  }
}

export type BrowserReadiness = "load" | "domContentLoaded" | "none";

/** What the agent host can ask of one tab's WebView. */
export interface BrowserTabController {
  readonly run: (operation: string, input: unknown, timeoutMs: number) => Promise<unknown>;
  readonly load: (url: string) => void;
  readonly waitForLoad: (readiness: BrowserReadiness, timeoutMs: number) => Promise<void>;
  readonly goBack: () => void;
  readonly goForward: () => void;
  readonly reload: () => void;
  readonly stop: () => void;
  readonly viewport: () => { readonly width: number; readonly height: number };
}

const controllers = new Map<string, BrowserTabController>();
const controllerWaiters = new Map<string, Array<(controller: BrowserTabController) => void>>();

/** The tab's controller once its WebView has mounted. */
export function browserTabController(
  key: string,
  timeoutMs: number,
): Promise<BrowserTabController> {
  const existing = controllers.get(key);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new BrowserHostError(
          "PreviewAutomationTimeoutError",
          "The browser tab did not start in time.",
        ),
      );
    }, timeoutMs);
    const waiters = controllerWaiters.get(key) ?? [];
    waiters.push((controller) => {
      clearTimeout(timer);
      resolve(controller);
    });
    controllerWaiters.set(key, waiters);
  });
}

/** Called by a tab's WebView when it mounts; returns the function to call when it unmounts. */
export function registerBrowserTabController(
  key: string,
  controller: BrowserTabController,
): () => void {
  controllers.set(key, controller);
  const waiters = controllerWaiters.get(key) ?? [];
  controllerWaiters.delete(key);
  for (const waiter of waiters) waiter(controller);
  return () => {
    if (controllers.get(key) === controller) controllers.delete(key);
  };
}
