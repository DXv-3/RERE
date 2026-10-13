import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { BrowserNavigationTarget, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";
import { previewEnvironment } from "../../state/preview";
import { environmentSession } from "../../state/session";
import { browserStore, type BrowserTab } from "./browserStore";
import { BrowserHostError, browserTabController } from "./browserControllers";
import { resolveMobileBrowserUrl } from "./browserTargets";

const QUIET = { reportFailure: false, reportDefect: false } as const;
const TITLE_MAX = 512;

function environmentBaseUrl(environmentId: EnvironmentId): string | null {
  const prepared = appAtomRegistry.get(
    environmentSession.preparedConnectionValueAtom(environmentId),
  );
  return Option.isSome(prepared) ? prepared.value.httpBaseUrl : null;
}

/** The address the phone loads for a target, or a tagged error saying why it cannot. */
export function resolveBrowserTarget(
  environmentId: EnvironmentId,
  target: BrowserNavigationTarget,
): string {
  return resolveMobileBrowserUrl(target, environmentBaseUrl(environmentId));
}

function commandFailure(result: { readonly _tag: string }, action: string): never {
  const cause = AsyncResult.isFailure(result as never)
    ? (result as { cause?: unknown }).cause
    : null;
  throw new BrowserHostError(
    "PreviewAutomationUnavailableError",
    `Could not ${action} on the CodeWrench server${cause ? "" : "."}`,
  );
}

/**
 * Opens a new tab for the thread as a server preview session, so agents and other clients see it,
 * and starts loading `url` in the phone's WebView when one is given.
 */
export async function openBrowserTab(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly url?: string;
}): Promise<BrowserTab> {
  const result = await runAtomCommand(
    appAtomRegistry,
    previewEnvironment.open,
    {
      environmentId: input.environmentId,
      input: { threadId: input.threadId, ...(input.url === undefined ? {} : { url: input.url }) },
    },
    QUIET,
  );
  if (result._tag !== "Success") commandFailure(result, "open a browser tab");
  return browserStore.upsertTab({
    environmentId: input.environmentId,
    threadId: input.threadId,
    tabId: result.value.tabId,
    url: input.url ?? null,
    title: input.url ?? "New Tab",
    loading: input.url !== undefined,
    canGoBack: false,
    canGoForward: false,
  });
}

/** Points an open tab at `url`: the server records it, the WebView loads it. */
export async function navigateBrowserTab(tab: BrowserTab, url: string): Promise<void> {
  const result = await runAtomCommand(
    appAtomRegistry,
    previewEnvironment.navigate,
    {
      environmentId: tab.environmentId,
      input: { threadId: tab.threadId, tabId: tab.tabId, url },
    },
    QUIET,
  );
  if (result._tag !== "Success") commandFailure(result, "navigate the browser tab");
  (await browserTabController(tab.key, 5_000)).load(url);
  browserStore.setCurrent(tab.key);
}

export async function closeBrowserTab(tab: BrowserTab): Promise<void> {
  browserStore.removeTab(tab.key);
  await runAtomCommand(
    appAtomRegistry,
    previewEnvironment.close,
    { environmentId: tab.environmentId, input: { threadId: tab.threadId, tabId: tab.tabId } },
    QUIET,
  );
}

/** Tells the server where a tab is and whether it loaded, as the desktop does after each load. */
export function reportBrowserTabStatus(
  tab: BrowserTab,
  page: {
    readonly url: string;
    readonly title: string;
    readonly failure: { readonly code: number; readonly description: string } | null;
  },
): void {
  const title = page.title.slice(0, TITLE_MAX);
  void runAtomCommand(
    appAtomRegistry,
    previewEnvironment.reportStatus,
    {
      environmentId: tab.environmentId,
      input: {
        threadId: tab.threadId,
        tabId: tab.tabId,
        navStatus:
          page.failure === null
            ? { _tag: "Success", url: page.url, title }
            : {
                _tag: "LoadFailed",
                url: page.url,
                title,
                code: Math.trunc(page.failure.code),
                description: page.failure.description,
              },
        canGoBack: tab.canGoBack,
        canGoForward: tab.canGoForward,
      },
    },
    QUIET,
  );
}
