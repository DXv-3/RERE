import type {
  EditorId,
  EnvironmentId,
  ProjectScript,
  ResolvedKeybindingsConfig,
  ThreadId,
} from "@t3tools/contracts";
import { AlertTriangleIcon, FolderIcon, XIcon } from "lucide-react";

import type { DraftId } from "../../composerDraftStore";
import { useT3ProjectFileScripts } from "../../hooks/useT3ProjectFileScripts";
import {
  shouldShowEnvironmentIndicator,
  type EnvMode,
  type EnvironmentOption,
} from "../BranchToolbar.logic";
import { BranchToolbar } from "../BranchToolbar";
import { BranchToolbarEnvironmentSelector } from "../BranchToolbarEnvironmentSelector";
import GitActionsControl from "../GitActionsControl";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ComponentProps } from "react";
import { ThreadDetailsCard } from "./ThreadDetailsCard";
import { OpenInPicker } from "./OpenInPicker";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from "./threadDetailsPanelStyles";
import { ThreadAutomationsPanel } from "./ThreadAutomationsPanel";
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";

interface VersionMismatchIssue {
  readonly clientVersion: string;
  readonly serverVersion: string;
  readonly serverLabel: string;
}

export interface ThreadDetailsPanelProps extends Pick<
  ComponentProps<typeof ThreadDetailsCard>,
  "anchor" | "handle" | "onPresentationChange"
> {
  forceNewWorktree?: boolean;
  /** A thread without a project has no repository, editor or scripts to offer. */
  projectless?: boolean;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  draftId?: DraftId;
  activeProjectName: string | undefined;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  showOpenInPicker: boolean;
  gitCwd: string | null;
  isGitRepo: boolean;
  envLocked: boolean;
  availableEnvironments: readonly EnvironmentOption[];
  autoEnvironmentLabel?: string | undefined;
  onAutoEnvironment?: (() => void) | undefined;
  onEnvironmentChange: (environmentId: EnvironmentId) => void;
  onEnvModeChange: (mode: EnvMode) => void;
  /** The thread's env mode as ChatView resolves it. */
  envMode: EnvMode;
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (branch: string | null) => void;
  startFromOrigin: boolean;
  onStartFromOriginChange: (startFromOrigin: boolean) => void;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest: () => void;
  onOpenChanges?: () => void;
  versionMismatch: VersionMismatchIssue | null;
  onDismissVersionMismatch: () => void;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
}

export function ThreadDetailsPanel(props: ThreadDetailsPanelProps) {
  const projectless = props.projectless === true;
  const fileScripts = useT3ProjectFileScripts(
    props.environmentId,
    props.activeProjectScripts ? props.gitCwd : null,
  );
  // Same rule as the composer strip: a lone remote machine still gets a row,
  // shown as a static label because there is nothing to pick.
  const canPickEnvironment = props.availableEnvironments.length > 1;
  const showEnvironment = shouldShowEnvironmentIndicator({
    activeEnvironment:
      props.availableEnvironments.find((env) => env.environmentId === props.environmentId) ?? null,
    canPickEnvironment,
  });
  const branchToolbarProps = {
    showGitControls: props.isGitRepo,
    environmentId: props.environmentId,
    threadId: props.threadId,
    ...(props.draftId ? { draftId: props.draftId } : {}),
    onEnvModeChange: props.onEnvModeChange,
    startFromOrigin: props.startFromOrigin,
    onStartFromOriginChange: props.onStartFromOriginChange,
    envMode: props.envMode,
    ...(props.activeThreadBranchOverride !== undefined
      ? { activeThreadBranchOverride: props.activeThreadBranchOverride }
      : {}),
    ...(props.onActiveThreadBranchOverrideChange
      ? { onActiveThreadBranchOverrideChange: props.onActiveThreadBranchOverrideChange }
      : {}),
    envLocked: props.envLocked,
    forceNewWorktree: props.forceNewWorktree ?? false,
    onComposerFocusRequest: props.onComposerFocusRequest,
    ...(props.onCheckoutPullRequestRequest
      ? { onCheckoutPullRequestRequest: props.onCheckoutPullRequestRequest }
      : {}),
  };

  return (
    <ThreadDetailsCard
      threadRef={{ environmentId: props.environmentId, threadId: props.threadId }}
      anchor={props.anchor}
      handle={props.handle}
      onPresentationChange={props.onPresentationChange}
    >
      {(density) => (
        <>
          {props.versionMismatch ? (
            <div className="mx-2 mt-2 flex items-center gap-2.5 rounded-lg px-2.5 py-1.5">
              <AlertTriangleIcon className="size-4 shrink-0 text-warning" />
              <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                <span className="font-medium text-foreground/80">
                  Client and server versions differ
                </span>
                {" · "}
                Client {props.versionMismatch.clientVersion} · {props.versionMismatch.serverLabel}{" "}
                {props.versionMismatch.serverVersion}
              </p>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Dismiss version mismatch warning"
                onClick={props.onDismissVersionMismatch}
              >
                <XIcon className="size-3.5" />
              </Button>
            </div>
          ) : null}

          {/*
            Every section below renders nothing when it has no content, so the
            hint is the wrapper's only child exactly when nothing applies.
          */}
          <div>
            {density === "full" && !props.draftId ? (
              <ThreadAutomationsPanel
                environmentId={props.environmentId}
                threadId={props.threadId}
              />
            ) : null}

            {props.gitCwd && !projectless && props.isGitRepo ? (
              <BranchToolbar
                layout="panel"
                panelSection="pull-requests"
                panelHeading={density === "full"}
                {...branchToolbarProps}
              />
            ) : null}

            {density === "full" && !props.draftId ? (
              <ThreadRelationshipsPanel
                environmentId={props.environmentId}
                threadId={props.threadId}
              />
            ) : null}

            {!projectless ? (
              <ThreadDetailsSection
                headingId="thread-details-workspace-heading"
                title="Workspace"
                showHeading={density === "full"}
              >
                <div className="flex flex-col">
                  {props.activeProjectName ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <div
                            className={`flex h-8 min-w-0 items-center rounded-lg ${THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS} text-sm font-medium text-foreground/80`}
                            data-thread-details-folder
                          />
                        }
                      >
                        <FolderIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
                        <span className="min-w-0 truncate">{props.activeProjectName}</span>
                      </TooltipTrigger>
                      <TooltipPopup side="left">
                        {props.gitCwd ?? props.activeProjectName}
                      </TooltipPopup>
                    </Tooltip>
                  ) : null}

                  {density === "full" ? (
                    <BranchToolbar
                      layout="panel"
                      panelSection="workspace"
                      {...branchToolbarProps}
                    />
                  ) : null}

                  {props.gitCwd && props.isGitRepo ? (
                    <BranchToolbar layout="panel" panelSection="branch" {...branchToolbarProps} />
                  ) : null}

                  {density !== "essential" && props.showOpenInPicker ? (
                    <OpenInPicker
                      environmentId={props.environmentId}
                      keybindings={props.keybindings}
                      availableEditors={props.availableEditors}
                      openInCwd={props.gitCwd}
                      displayMode="panel"
                    />
                  ) : null}

                  {props.activeProjectScripts ? (
                    <ProjectScriptsControl
                      displayMode="panel"
                      scripts={props.activeProjectScripts}
                      fileScripts={fileScripts}
                      keybindings={props.keybindings}
                      preferredScriptId={props.preferredScriptId}
                      onRunScript={props.onRunProjectScript}
                      onAddScript={props.onAddProjectScript}
                      onUpdateScript={props.onUpdateProjectScript}
                      onDeleteScript={props.onDeleteProjectScript}
                    />
                  ) : null}

                  {props.gitCwd && props.activeProjectName ? (
                    <GitActionsControl
                      displayMode="panel"
                      compact={density !== "full"}
                      gitCwd={props.gitCwd}
                      activeThreadRef={{
                        environmentId: props.environmentId,
                        threadId: props.threadId,
                      }}
                      {...(props.draftId ? { draftId: props.draftId } : {})}
                      {...(props.onOpenChanges ? { onOpenChanges: props.onOpenChanges } : {})}
                    />
                  ) : null}
                </div>
              </ThreadDetailsSection>
            ) : null}

            <p className="hidden px-3.5 py-3 text-xs text-muted-foreground only:block">
              Nothing attached to this thread yet.
            </p>
          </div>

          {density === "full" && showEnvironment ? (
            <div
              className="border-t border-border/65 px-2 py-1 text-muted-foreground [&_[data-composer-context-control]]:h-7 [&_[data-composer-context-control]]:text-xs [&_[data-composer-context-control]]:font-normal"
              data-thread-details-machine
            >
              <BranchToolbarEnvironmentSelector
                displayMode="panel"
                autoEnvironmentLabel={props.autoEnvironmentLabel}
                onAutoEnvironment={props.onAutoEnvironment}
                envLocked={props.envLocked}
                environmentId={props.environmentId}
                availableEnvironments={props.availableEnvironments}
                {...(canPickEnvironment ? { onEnvironmentChange: props.onEnvironmentChange } : {})}
              />
            </div>
          ) : null}
        </>
      )}
    </ThreadDetailsCard>
  );
}
