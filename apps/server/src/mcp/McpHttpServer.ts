import * as NodeCrypto from "node:crypto";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as Types from "effect/Types";
import { McpProtocol, McpSchema, McpServer, Tool } from "effect/unstable/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { agentToolGroupSwitchedOffMessage, PreviewAutomationError } from "@t3tools/contracts";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as AgentWorkspace from "../agents/AgentWorkspace.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as MediaService from "../media/MediaService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as AgentToolAccess from "./AgentToolAccess.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as AgentGoalsMcpService from "./AgentGoalsMcpService.ts";
import * as AgentSecretsMcpService from "./AgentSecretsMcpService.ts";
import * as AgentTeamMcpService from "./AgentTeamMcpService.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { PreviewControlsToolkit } from "./toolkits/previewControls/tools.ts";
import { PreviewControlsHandlersLive } from "./toolkits/previewControls/handlers.ts";
import { EnvironmentToolkit } from "./toolkits/environment/tools.ts";
import { EnvironmentHandlersLive } from "./toolkits/environment/handlers.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
import { ProjectHandlersLive } from "./toolkits/project/handlers.ts";
import { AttachmentToolkit } from "./toolkits/attachment/tools.ts";
import { AttachmentHandlersLive } from "./toolkits/attachment/handlers.ts";
import { ThreadToolkit } from "./toolkits/thread/tools.ts";
import { ThreadToolkitHandlersLive } from "./toolkits/thread/handlers.ts";
import * as ThreadMetadataMcpService from "./ThreadMetadataMcpService.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import { OrchestratorToolkitHandlersLive } from "./toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import {
  PreviewSnapshotToolkitHandlersLive,
  PreviewStandardToolkitHandlersLive,
} from "./toolkits/preview/handlers.ts";
import {
  PreviewSnapshotTool,
  PreviewSnapshotToolkit,
  PreviewStandardToolkit,
} from "./toolkits/preview/tools.ts";
import { MediaToolkitHandlersLive, mediaInspectOutput } from "./toolkits/media/handlers.ts";
import { MediaInspectTool, MediaToolkit, type MediaInspectResult } from "./toolkits/media/tools.ts";
import { MediaEditToolkitHandlersLive } from "./toolkits/media/editHandlers.ts";
import { MediaEditToolkit } from "./toolkits/media/editTools.ts";
import { CampaignsToolkitHandlersLive } from "./toolkits/campaigns/handlers.ts";
import { CampaignsToolkit } from "./toolkits/campaigns/tools.ts";
import { StudioToolkit, StudioToolkitHandlersLive } from "./toolkits/campaigns/studioTools.ts";
import { MediaGenerationToolkitHandlersLive } from "./toolkits/campaigns/generationHandlers.ts";
import { MediaGenerationToolkit } from "./toolkits/campaigns/generationTools.ts";
import { WorktreeToolkitHandlersLive } from "./toolkits/worktree/handlers.ts";
import { WorktreeToolkit } from "./toolkits/worktree/tools.ts";
import * as WorktreeMcpService from "./WorktreeMcpService.ts";
import { PullRequestsToolkitHandlersLive } from "./toolkits/pullRequests/handlers.ts";
import { PullRequestsToolkit } from "./toolkits/pullRequests/tools.ts";
import {
  DeviceScreenshotToolkitHandlersLive,
  DeviceStandardToolkitHandlersLive,
} from "./toolkits/device/handlers.ts";
import {
  DeviceScreenshotTool,
  DeviceScreenshotToolkit,
  DeviceStandardToolkit,
} from "./toolkits/device/tools.ts";

const unauthorized = HttpServerResponse.jsonUnsafe(
  {
    error: "invalid_mcp_credential",
    message: "A valid provider-scoped MCP bearer credential is required.",
  },
  {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": "Bearer",
    },
  },
);

type AuthenticatedHttpEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  McpInvocationContext.McpInvocationContext
>;

type McpAuthMiddleware = (
  httpEffect: AuthenticatedHttpEffect,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>;

export const normalizeMcpHttpResponse = (
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse => {
  const bodyIsEmpty =
    response.body._tag === "Empty" ||
    (response.body._tag === "Uint8Array" && response.body.contentLength === 0) ||
    (response.body._tag === "Raw" && response.body.contentLength === 0);
  return response.status === 200 && bodyIsEmpty
    ? HttpServerResponse.setStatus(response, 202)
    : response;
};

/** Exported for tests. */
export const makeMcpAuthMiddleware = Effect.gen(function* () {
  const registry = yield* McpSessionRegistry.McpSessionRegistry;
  const agents = yield* AgentWorkspace.AgentWorkspace;
  const authenticate: McpAuthMiddleware = Effect.fn("McpHttpServer.authenticateRequest")(
    function* (httpEffect) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const authorization = request.headers.authorization;
      const token =
        authorization?.startsWith("Bearer ") === true
          ? authorization.slice("Bearer ".length).trim()
          : "";
      // Resolved on every request: the owner's switches for the calling agent apply to the next
      // call of a session that is already running, without minting it a new credential.
      const invocation = yield* AgentToolAccess.resolveCallScope(registry, agents, token);
      if (!invocation) {
        // Without this the only symptom of a dead credential is the agent
        // quietly losing the whole `t3-code` toolkit for the rest of its
        // session, with nothing on the server to explain why.
        yield* Effect.logWarning("rejected MCP request with an unusable credential", {
          reason: token.length === 0 ? "missing_bearer_token" : "unknown_or_expired_token",
        });
        return unauthorized;
      }
      return yield* httpEffect.pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.map(normalizeMcpHttpResponse),
      );
    },
  );
  return authenticate;
}).pipe(Effect.withSpan("McpHttpServer.makeAuthMiddleware"));

const McpAuthMiddlewareLive = HttpRouter.middleware<{
  provides: McpInvocationContext.McpInvocationContext;
}>()(makeMcpAuthMiddleware).layer;

/**
 * Claude Code moves an MCP result above its output limit to a file and hands
 * the agent a notice instead, so a snapshot that carries the full
 * accessibility tree and page text loses its locators too. Claude Code also
 * shows the model `structuredContent` in place of the text blocks when a
 * result has both, so both carry the same bounded snapshot. Keep it near
 * 20 KB and tell the agent what was cut. The short `omitted` notes may go a
 * little over; the provider limit is far above this.
 */
export const MAX_SNAPSHOT_TEXT_BYTES = 20_000;
const MAX_SNAPSHOT_VISIBLE_TEXT_CHARS = 8_000;
const MAX_SNAPSHOT_ELEMENT_NAME_CHARS = 200;
const MAX_SNAPSHOT_LOG_ENTRIES = 40;
const MAX_SNAPSHOT_LOG_TEXT_CHARS = 500;
const MAX_SNAPSHOT_IDENTIFIER_CHARS = 2_048;

const encodeJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const utf8Length = (text: string) => Buffer.byteLength(text, "utf8");
const cutText = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** Shortens every string field of a log entry; other fields pass through. */
const cutEntryStrings = <A>(entry: A): A =>
  typeof entry === "object" && entry !== null
    ? (Object.fromEntries(
        Object.entries(entry).map(([key, value]) => [
          key,
          typeof value === "string" ? cutText(value, MAX_SNAPSHOT_LOG_TEXT_CHARS) : value,
        ]),
      ) as A)
    : entry;

const hasLongString = (entry: unknown, max: number) =>
  typeof entry === "object" &&
  entry !== null &&
  Object.values(entry).some((value) => typeof value === "string" && value.length > max);

type SnapshotMetadata = {
  readonly url: string;
  readonly title: string;
  readonly visibleText: string;
  readonly interactiveElements: ReadonlyArray<{
    readonly name: string;
    readonly [key: string]: unknown;
  }>;
  readonly consoleEntries: ReadonlyArray<unknown>;
  readonly networkEntries: ReadonlyArray<unknown>;
  readonly actionTimeline: ReadonlyArray<unknown>;
  readonly [key: string]: unknown;
};

/**
 * Drops the accessibility tree, shortens page text, element names, identifiers,
 * and log strings, keeps only the newest log entries, and finally sheds
 * interactive elements until the JSON fits. Returns the bounded value, its
 * text, and notes on what is missing so the agent can reach for
 * preview_evaluate.
 */
const boundSnapshotMetadata = (metadata: SnapshotMetadata) => {
  const omitted: Array<string> = [];
  const { accessibilityTree, ...withoutTree } = metadata;
  if (accessibilityTree !== undefined) {
    omitted.push("accessibilityTree (use interactiveElements locators or preview_evaluate)");
  }
  const tail = <A>(entries: ReadonlyArray<A>, label: string) => {
    if (entries.length > MAX_SNAPSHOT_LOG_ENTRIES) {
      omitted.push(`${entries.length - MAX_SNAPSHOT_LOG_ENTRIES} older ${label}`);
    }
    const kept = entries.slice(-MAX_SNAPSHOT_LOG_ENTRIES);
    if (kept.some((entry) => hasLongString(entry, MAX_SNAPSHOT_LOG_TEXT_CHARS))) {
      omitted.push(`${label} text after ${MAX_SNAPSHOT_LOG_TEXT_CHARS} characters`);
    }
    return kept.map(cutEntryStrings);
  };
  if (
    metadata.url.length > MAX_SNAPSHOT_IDENTIFIER_CHARS ||
    metadata.title.length > MAX_SNAPSHOT_IDENTIFIER_CHARS
  ) {
    omitted.push(`url or title after ${MAX_SNAPSHOT_IDENTIFIER_CHARS} characters`);
  }
  if (
    metadata.interactiveElements.some(
      (element) => element.name.length > MAX_SNAPSHOT_ELEMENT_NAME_CHARS,
    )
  ) {
    omitted.push(`element names longer than ${MAX_SNAPSHOT_ELEMENT_NAME_CHARS} characters`);
  }
  const bounded = {
    ...withoutTree,
    url: cutText(metadata.url, MAX_SNAPSHOT_IDENTIFIER_CHARS),
    title: cutText(metadata.title, MAX_SNAPSHOT_IDENTIFIER_CHARS),
    interactiveElements: metadata.interactiveElements.map((element) => ({
      ...element,
      name: cutText(element.name, MAX_SNAPSHOT_ELEMENT_NAME_CHARS),
    })),
    consoleEntries: tail(metadata.consoleEntries, "console entries"),
    networkEntries: tail(metadata.networkEntries, "network entries"),
    actionTimeline: tail(metadata.actionTimeline, "action timeline entries"),
  };

  // Per-field caps do not sum below the ceiling: three log arrays of 40 capped
  // entries alone can pass 60 KB, and the caps count characters, not bytes.
  // Halve one thing per round until the JSON fits: logs first, then page
  // text, then the locators. The identifier caps bound the rest, so this
  // terminates.
  const shedOrder = [
    "actionTimeline",
    "networkEntries",
    "consoleEntries",
    "interactiveElements",
  ] as const;
  const lists: Record<(typeof shedOrder)[number], ReadonlyArray<unknown>> = {
    interactiveElements: bounded.interactiveElements,
    consoleEntries: bounded.consoleEntries,
    networkEntries: bounded.networkEntries,
    actionTimeline: bounded.actionTimeline,
  };
  const dropped: Record<(typeof shedOrder)[number], number> = {
    interactiveElements: 0,
    consoleEntries: 0,
    networkEntries: 0,
    actionTimeline: 0,
  };
  let visibleTextChars = Math.min(metadata.visibleText.length, MAX_SNAPSHOT_VISIBLE_TEXT_CHARS);
  const value = () => ({
    ...bounded,
    visibleText: cutText(metadata.visibleText, visibleTextChars),
    ...lists,
  });
  let text = encodeJsonText(value());
  while (utf8Length(text) > MAX_SNAPSHOT_TEXT_BYTES) {
    // Elements carry the locators, so they go last; logs shed newest-last.
    const key =
      shedOrder.find(
        (candidate) => candidate !== "interactiveElements" && lists[candidate].length > 0,
      ) ??
      (visibleTextChars > 0
        ? "visibleText"
        : lists.interactiveElements.length > 0
          ? "interactiveElements"
          : undefined);
    if (key === undefined) break;
    if (key === "visibleText") {
      visibleTextChars = Math.floor(visibleTextChars / 2);
    } else {
      const keep = Math.floor(lists[key].length / 2);
      dropped[key] += lists[key].length - keep;
      // slice(-0) keeps everything, so spell out the empty case.
      lists[key] =
        keep === 0
          ? []
          : key === "interactiveElements"
            ? lists[key].slice(0, keep)
            : lists[key].slice(-keep);
    }
    text = encodeJsonText(value());
  }
  if (visibleTextChars < metadata.visibleText.length) {
    omitted.push(
      `visibleText after ${visibleTextChars} characters (use preview_evaluate for more)`,
    );
  }
  for (const key of shedOrder) {
    if (dropped[key] > 0) {
      omitted.push(`${dropped[key]} of ${bounded[key].length} ${key}`);
    }
  }
  return { value: value(), text, omitted };
};

export class PreviewScreenshotSaveError extends Schema.TaggedError<PreviewScreenshotSaveError>()(
  "PreviewScreenshotSaveError",
  { screenshotPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not save preview screenshot to ${this.screenshotPath}.`;
  }
}

const MAX_SCREENSHOT_SITE_SLUG_LENGTH = 40;

/** Hostname reduced to a filename-safe slug, matching the desktop's own screenshot names. */
const screenshotSiteSlug = (rawUrl: string): string => {
  try {
    const slug = new URL(rawUrl).hostname
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_SCREENSHOT_SITE_SLUG_LENGTH)
      .replace(/-+$/g, "");
    return slug || "site";
  } catch {
    return "site";
  }
};

/** Writes the snapshot PNG under the browser artifacts directory and returns its path. */
const saveScreenshot = Effect.fn("McpHttpServer.saveScreenshot")(function* (
  pageUrl: string,
  data: Uint8Array,
) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const millis = yield* Clock.currentTimeMillis;
  // Two saves in the same millisecond must not overwrite each other.
  const fileName = `browser-screenshot-${screenshotSiteSlug(pageUrl)}-${millis.toString(36)}-${NodeCrypto.randomUUID().slice(0, 8)}.png`;
  const screenshotPath = path.join(config.browserArtifactsDir, fileName);
  yield* fileSystem.makeDirectory(config.browserArtifactsDir, { recursive: true }).pipe(
    Effect.andThen(fileSystem.writeFile(screenshotPath, data)),
    Effect.mapError((cause) => new PreviewScreenshotSaveError({ screenshotPath, cause })),
  );
  return screenshotPath;
});

const isPreviewAutomationError = Schema.is(PreviewAutomationError);

const previewSnapshotFailure = <E>(cause: Cause.Cause<E>) => {
  if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
    return Effect.failCause(cause).pipe(Effect.orDie);
  }
  const failures = cause.reasons.filter(Cause.isFailReason);
  const firstFailure = failures[0]?.error;
  const errorTag =
    typeof firstFailure === "object" &&
    firstFailure !== null &&
    "_tag" in firstFailure &&
    typeof firstFailure._tag === "string"
      ? firstFailure._tag
      : "PreviewSnapshotError";
  // Preview errors build their message on the server, never from page output,
  // and it tells the agent what to do next, such as falling back to a shell browser.
  const message = isPreviewAutomationError(firstFailure) ? firstFailure.message : undefined;
  const result = new McpSchema.CallToolResult({
    isError: true,
    structuredContent: {
      error: {
        _tag: errorTag,
        operation: "snapshot",
        failureCount: failures.length,
        ...(message === undefined ? {} : { message }),
      },
    },
    // Some clients show only the text content and others only structuredContent, so both carry it.
    content: [{ type: "text", text: `Preview snapshot failed: ${message ?? `${errorTag}.`}` }],
  });
  return Effect.logWarning("preview snapshot failed", {
    operation: "snapshot",
    errorTag,
    failureCount: failures.length,
  }).pipe(Effect.as(result));
};

const registerPreviewSnapshot = Effect.fn("McpHttpServer.registerPreviewSnapshot")(function* () {
  const server = yield* McpServer.McpServer;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const secrets = yield* AgentSecretsMcpService.AgentSecretsMcpService;
  // The MCP tool runner only supplies the client, so hand the save path its services here.
  const saveServices = yield* Effect.context<
    ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path
  >();
  const built = yield* PreviewSnapshotToolkit;
  const tool = PreviewSnapshotTool;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
      annotations: {
        ...Context.getOption(tool.annotations, Tool.Title).pipe(
          Option.map((title) => ({ title })),
          Option.getOrUndefined,
        ),
        readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
        destructiveHint: Context.get(tool.annotations, Tool.Destructive),
        idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
        openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
      },
    }),
    annotations: tool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        return built.handle("preview_snapshot", payload).pipe(
          Stream.unwrap,
          Stream.run(Sink.last()),
          Effect.flatMap(Effect.fromOption),
          Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, broker),
          Effect.provideService(AgentSecretsMcpService.AgentSecretsMcpService, secrets),
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.flatMap(({ encodedResult }) =>
            Effect.gen(function* () {
              const snapshot = encodedResult as SnapshotMetadata & {
                readonly url: string;
                readonly screenshot?: {
                  readonly mimeType: "image/png";
                  readonly data: string;
                  readonly width: number;
                  readonly height: number;
                };
              };
              const { screenshot, ...page } = snapshot;
              // The phone app's browser cannot capture the page; its snapshot is text only.
              const png =
                screenshot === undefined
                  ? undefined
                  : new Uint8Array(Buffer.from(screenshot.data, "base64"));
              const screenshotPath =
                payload?.save === true && png !== undefined
                  ? yield* saveScreenshot(page.url, png)
                  : undefined;
              if (screenshotPath !== undefined && payload?.includeImage === false) {
                // The agent only wants a file to show the user. The url keeps the site icon on the tool row.
                const saved = {
                  url: cutText(page.url, MAX_SNAPSHOT_IDENTIFIER_CHARS),
                  screenshotPath,
                };
                return new McpSchema.CallToolResult({
                  isError: false,
                  structuredContent: saved,
                  content: [{ type: "text", text: encodeJsonText(saved) }],
                });
              }
              const metadata = {
                ...page,
                ...(screenshot === undefined
                  ? {
                      screenshotUnavailable:
                        "This browser runs in the CodeWrench phone app, which cannot take screenshots. Use the page text and interactive elements.",
                    }
                  : {
                      screenshot: {
                        mimeType: screenshot.mimeType,
                        width: screenshot.width,
                        height: screenshot.height,
                      },
                    }),
                ...(screenshotPath === undefined ? {} : { screenshotPath }),
              };
              const bounded = boundSnapshotMetadata(metadata);
              return new McpSchema.CallToolResult({
                isError: false,
                structuredContent:
                  bounded.omitted.length === 0
                    ? bounded.value
                    : { ...bounded.value, omitted: bounded.omitted },
                content: [
                  // Keep the page identity readable even if a provider truncates the snapshot.
                  {
                    type: "text",
                    text: encodeJsonText({
                      url: cutText(page.url, MAX_SNAPSHOT_IDENTIFIER_CHARS),
                    }),
                  },
                  { type: "text", text: bounded.text },
                  ...(bounded.omitted.length === 0
                    ? []
                    : [
                        {
                          type: "text" as const,
                          text: `Snapshot text was bounded. Omitted: ${bounded.omitted.join("; ")}.`,
                        },
                      ]),
                  ...(payload?.includeImage === false ||
                  png === undefined ||
                  screenshot === undefined
                    ? []
                    : [{ type: "image" as const, data: png, mimeType: screenshot.mimeType }]),
                ],
              });
            }),
          ),
          Effect.provide(saveServices),
          Effect.matchCauseEffect({
            onFailure: previewSnapshotFailure,
            onSuccess: Effect.succeed,
          }),
        );
      }),
  });
});

/** What an image tool's result becomes: JSON text for the model plus the pictures it should see. */
interface ImageToolOutput {
  readonly metadata: object;
  readonly images: ReadonlyArray<{ readonly data: string; readonly mimeType: string }>;
}

type ImageToolShape = (encodedResult: unknown, payload: unknown) => ImageToolOutput;

interface ImageToolResult {
  readonly screenshot: {
    readonly mimeType: "image/png";
    readonly data: string;
    readonly width: number;
    readonly height: number;
  };
  readonly [key: string]: unknown;
}

/**
 * Failures surface only their tag: the remote message may carry renderer or
 * device output the agent should not see, and the tag is what it can act on.
 */
const imageToolFailure =
  (toolName: string, operation: string, failureText: string | ((failure: unknown) => string)) =>
  <E>(cause: Cause.Cause<E>) => {
    if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
      return Effect.failCause(cause).pipe(Effect.orDie);
    }
    const failures = cause.reasons.filter(Cause.isFailReason);
    const firstFailure = failures[0]?.error;
    const errorTag =
      typeof firstFailure === "object" &&
      firstFailure !== null &&
      "_tag" in firstFailure &&
      typeof firstFailure._tag === "string"
        ? firstFailure._tag
        : `${toolName}Error`;
    const result = new McpSchema.CallToolResult({
      isError: true,
      structuredContent: {
        error: {
          _tag: errorTag,
          operation,
          failureCount: failures.length,
        },
      },
      content: [
        {
          type: "text",
          text: typeof failureText === "string" ? failureText : failureText(firstFailure),
        },
      ],
    });
    return Effect.logWarning(`${toolName} failed`, {
      operation,
      errorTag,
      failureCount: failures.length,
    }).pipe(Effect.as(result));
  };

/** A device screenshot: one PNG, left out when the caller asks for text only. */
const screenshotToolShape: ImageToolShape = (encodedResult, payload) => {
  const { screenshot, ...rest } = encodedResult as ImageToolResult;
  const includeImage =
    (payload as { readonly includeImage?: boolean } | undefined)?.includeImage !== false;
  return {
    metadata: {
      ...rest,
      screenshot: {
        mimeType: screenshot.mimeType,
        width: screenshot.width,
        height: screenshot.height,
      },
    },
    images: includeImage ? [{ data: screenshot.data, mimeType: screenshot.mimeType }] : [],
  };
};

const mediaInspectToolShape: ImageToolShape = (encodedResult) =>
  mediaInspectOutput(encodedResult as MediaInspectResult);

/**
 * `McpServer.toolkit` serializes every result as JSON text, which is the
 * wrong shape for a screenshot: the model needs image content. Tools whose
 * result carries a `screenshot` field are registered by hand so the PNG goes
 * out as an image block and the rest of the payload as JSON metadata.
 */
const registerImageTool = <T extends Tool.Any, E, R>(
  tool: T,
  handle: (payload: Tool.Parameters<T>) => Effect.Effect<{ readonly encodedResult: unknown }, E, R>,
  provide: (
    effect: Effect.Effect<{ readonly encodedResult: unknown }, E, R>,
  ) => Effect.Effect<
    { readonly encodedResult: unknown },
    E,
    McpInvocationContext.McpInvocationContext
  >,
  operation: string,
  failureText: string | ((failure: unknown) => string),
  /** A reason to refuse before running, shown to the model as written; it must be server-authored. */
  refusal?: (invocation: McpInvocationContext.McpInvocationScope) => string | undefined,
  shape: ImageToolShape = screenshotToolShape,
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: tool.name,
        description: Tool.getDescription(tool),
        inputSchema: Tool.getJsonSchema(tool),
        annotations: {
          ...Context.getOption(tool.annotations, Tool.Title).pipe(
            Option.map((title) => ({ title })),
            Option.getOrUndefined,
          ),
          readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
          destructiveHint: Context.get(tool.annotations, Tool.Destructive),
          idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
          openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
        },
      }),
      annotations: tool.annotations,
      handle: (payload) =>
        Effect.withFiber((fiber) => {
          const invocation = Context.getUnsafe(
            fiber.context,
            McpInvocationContext.McpInvocationContext,
          );
          const refused = refusal?.(invocation);
          if (refused !== undefined) {
            return Effect.succeed(
              new McpSchema.CallToolResult({
                isError: true,
                structuredContent: { error: { _tag: "McpCapabilityUnavailableError", operation } },
                content: [{ type: "text", text: refused }],
              }),
            );
          }
          return provide(handle(payload as Tool.Parameters<T>)).pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.matchCauseEffect({
              onFailure: imageToolFailure(tool.name, operation, failureText),
              onSuccess: ({ encodedResult }) => {
                const { metadata, images } = shape(encodedResult, payload);
                return Effect.succeed(
                  new McpSchema.CallToolResult({
                    isError: false,
                    structuredContent: metadata,
                    content: [
                      { type: "text", text: JSON.stringify(metadata) },
                      ...images.map((image) => ({
                        type: "image" as const,
                        data: new Uint8Array(Buffer.from(image.data, "base64")),
                        mimeType: image.mimeType,
                      })),
                    ],
                  }),
                );
              },
            }),
          );
        }),
    });
  });

const registerDeviceScreenshot = Effect.fn("McpHttpServer.registerDeviceScreenshot")(function* () {
  const devices = yield* DeviceService.DeviceService;
  const built = yield* DeviceScreenshotToolkit;
  yield* registerImageTool(
    DeviceScreenshotTool,
    (payload) =>
      built
        .handle("device_screenshot", payload)
        .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption)),
    (effect) => effect.pipe(Effect.provideService(DeviceService.DeviceService, devices)),
    "screenshot",
    "Device screenshot failed.",
    // The generic failure text hides why on purpose; an owner's switch is not a secret.
    (invocation) =>
      McpInvocationContext.isSwitchedOff(invocation, "device")
        ? agentToolGroupSwitchedOffMessage("device")
        : undefined,
  );
});

const registerMediaInspect = Effect.fn("McpHttpServer.registerMediaInspect")(function* () {
  const media = yield* MediaService.MediaService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const built = yield* MediaToolkit;
  yield* registerImageTool(
    MediaInspectTool,
    (payload) =>
      built
        .handle("media_inspect", payload)
        .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption)),
    (effect) =>
      effect.pipe(
        Effect.provideService(MediaService.MediaService, media),
        Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
        Effect.provideService(ProjectService.ProjectService, projects),
        Effect.provideService(WorkspaceFileSystem.WorkspaceFileSystem, files),
      ),
    "inspect",
    (failure) =>
      typeof failure === "object" && failure !== null && "message" in failure
        ? String((failure as { message: unknown }).message)
        : "Media inspection failed.",
    undefined,
    mediaInspectToolShape,
  );
});

const PreviewStandardToolkitRegistrationLive = McpServer.toolkit(PreviewStandardToolkit).pipe(
  Layer.provide(PreviewStandardToolkitHandlersLive),
  // preview_type can type one of the calling agent's own secrets by name.
  Layer.provide(AgentSecretsMcpService.layer),
);

const PreviewSnapshotRegistrationLive = Layer.effectDiscard(registerPreviewSnapshot()).pipe(
  Layer.provide(PreviewSnapshotToolkitHandlersLive),
  Layer.provide(AgentSecretsMcpService.layer),
);

export const PreviewToolkitRegistrationLive = Layer.mergeAll(
  PreviewStandardToolkitRegistrationLive,
  PreviewSnapshotRegistrationLive,
);

export const OrchestratorToolkitRegistrationLive = McpServer.toolkit(OrchestratorToolkit).pipe(
  Layer.provide(OrchestratorToolkitHandlersLive),
  // Before the orchestrator layer so the team service shares its one instance.
  Layer.provide(AgentTeamMcpService.layer),
  Layer.provide(OrchestratorMcpService.layer),
  Layer.provide(ThreadMetadataMcpService.layer),
  Layer.provide(AgentGoalsMcpService.layer),
  Layer.provide(AgentSecretsMcpService.layer),
);

export const ThreadToolkitRegistrationLive = McpServer.toolkit(ThreadToolkit).pipe(
  Layer.provide(ThreadToolkitHandlersLive),
);

const WorktreeToolkitRegistrationLive = McpServer.toolkit(WorktreeToolkit).pipe(
  Layer.provide(WorktreeToolkitHandlersLive),
  Layer.provide(WorktreeMcpService.layer),
);

const PreviewControlsRegistrationLive = McpServer.toolkit(PreviewControlsToolkit).pipe(
  Layer.provide(PreviewControlsHandlersLive),
);

const EnvironmentRegistrationLive = McpServer.toolkit(EnvironmentToolkit).pipe(
  Layer.provide(EnvironmentHandlersLive),
);

const ProjectRegistrationLive = McpServer.toolkit(ProjectToolkit).pipe(
  Layer.provide(ProjectHandlersLive),
);

const AttachmentRegistrationLive = McpServer.toolkit(AttachmentToolkit).pipe(
  Layer.provide(AttachmentHandlersLive),
);

export const PullRequestsToolkitRegistrationLive = McpServer.toolkit(PullRequestsToolkit).pipe(
  Layer.provide(PullRequestsToolkitHandlersLive),
);

const DeviceStandardToolkitRegistrationLive = McpServer.toolkit(DeviceStandardToolkit).pipe(
  Layer.provide(DeviceStandardToolkitHandlersLive),
);

const DeviceScreenshotRegistrationLive = Layer.effectDiscard(registerDeviceScreenshot()).pipe(
  Layer.provide(DeviceScreenshotToolkitHandlersLive),
);

export const DeviceToolkitRegistrationLive = Layer.mergeAll(
  DeviceStandardToolkitRegistrationLive,
  DeviceScreenshotRegistrationLive,
);

const MediaRegistrationLive = Layer.effectDiscard(registerMediaInspect()).pipe(
  Layer.provide(MediaToolkitHandlersLive),
);

const MediaEditRegistrationLive = McpServer.toolkit(MediaEditToolkit).pipe(
  Layer.provide(MediaEditToolkitHandlersLive),
);

const CampaignsRegistrationLive = McpServer.toolkit(CampaignsToolkit).pipe(
  Layer.provide(CampaignsToolkitHandlersLive),
);

const StudioRegistrationLive = McpServer.toolkit(StudioToolkit).pipe(
  Layer.provide(StudioToolkitHandlersLive),
);

const MediaGenerationRegistrationLive = McpServer.toolkit(MediaGenerationToolkit).pipe(
  Layer.provide(MediaGenerationToolkitHandlersLive),
);

const McpTransportLive = McpServer.layerHttp({
  name: "CodeWrench",
  version: packageJson.version,
  path: "/mcp",
  protocols: [McpProtocol.v2025_06_18],
}).pipe(Layer.provide(McpAuthMiddlewareLive));

export const layer = Layer.mergeAll(
  PreviewToolkitRegistrationLive,
  OrchestratorToolkitRegistrationLive,
  ThreadToolkitRegistrationLive,
  AttachmentRegistrationLive,
  ProjectRegistrationLive,
  EnvironmentRegistrationLive,
  PreviewControlsRegistrationLive,
  WorktreeToolkitRegistrationLive,
  PullRequestsToolkitRegistrationLive,
  DeviceToolkitRegistrationLive,
  MediaRegistrationLive,
  MediaEditRegistrationLive,
  CampaignsRegistrationLive,
  StudioRegistrationLive,
  MediaGenerationRegistrationLive,
).pipe(Layer.provideMerge(McpTransportLive));
