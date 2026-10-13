import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  describeTransferWorkspace,
  executeContinueOn,
  pickTransferModel,
  planTransferProject,
  type TransferTarget,
} from "@t3tools/client-runtime/operations/thread-transfer";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectId,
  ScopedThreadRef,
  ThreadTransferExport,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { create } from "zustand";

import { randomUUID } from "~/lib/utils";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useProjects, useThreadShell, waitForThreadShell } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { projectEnvironment } from "../../state/projects";
import { serverEnvironment } from "../../state/server";
import { useGitStackedAction } from "../../state/sourceControlActions";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { continueOnTargetIds } from "./continueOn.logic";

const SCRATCH_CHOICE = "scratch";
const FILE_LIST_LIMIT = 20;

const useRequest = create<{ threadRef: ScopedThreadRef | null }>(() => ({ threadRef: null }));

/** Opens the Continue On dialog for a thread. Safe to call from menus and the command palette. */
export function requestContinueOn(threadRef: ScopedThreadRef) {
  useRequest.setState({ threadRef });
}

function closeRequest() {
  useRequest.setState({ threadRef: null });
}

export function ContinueOnEnvironmentDialogHost() {
  const threadRef = useRequest((state) => state.threadRef);
  return threadRef ? (
    <ContinueOnEnvironmentDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
      onClose={closeRequest}
    />
  ) : null;
}

type ExportState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly data: ThreadTransferExport };

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : fallback;
}

function ContinueOnEnvironmentDialog({
  threadRef,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const projects = useProjects();
  const sourceThread = useThreadShell(threadRef);
  const { settleThread } = useThreadActions();
  const exportTransfer = useAtomCommand(serverEnvironment.exportThreadTransfer, {
    reportFailure: false,
  });
  const importTransfer = useAtomCommand(serverEnvironment.importThreadTransfer, {
    reportFailure: false,
  });
  const ensureScratch = useAtomCommand(projectEnvironment.ensureScratch, { reportFailure: false });

  const [exportState, setExportState] = useState<ExportState>({ kind: "loading" });
  const [targetEnvironmentId, setTargetEnvironmentId] = useState<EnvironmentId | null>(null);
  const [projectChoice, setProjectChoice] = useState<string | null>(null);
  const [conversationOnly, setConversationOnly] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [continuing, setContinuing] = useState(false);
  const [continueError, setContinueError] = useState<string | null>(null);

  const exported = exportState.kind === "ready" ? exportState.data : null;
  const push = useGitStackedAction({
    environmentId: threadRef.environmentId,
    cwd: exported?.workspace.cwd ?? null,
  });

  // The first read starts in the loading state; a re-read after a push shows it again.
  const loadExport = useEffectEvent(async (options: { readonly reload: boolean }) => {
    if (options.reload) setExportState({ kind: "loading" });
    const result = await exportTransfer({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    if (result._tag === "Success") {
      setExportState({ kind: "ready", data: result.value });
    } else if (!isAtomCommandInterrupted(result)) {
      setExportState({
        kind: "error",
        message: failureMessage(
          squashAtomCommandFailure(result),
          "Could not read this thread to continue it elsewhere.",
        ),
      });
    }
  });
  useEffect(() => {
    void loadExport({ reload: false });
  }, []);

  const environmentLabel = (environmentId: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === environmentId)?.label ??
    "that environment";
  const targets = useMemo(() => {
    const ids = new Set(
      continueOnTargetIds(
        threadRef.environmentId,
        environments.map((environment) => ({
          environmentId: environment.environmentId,
          connected: environment.connection.phase === "connected",
          serverConfig: environment.serverConfig,
        })),
      ),
    );
    return environments.filter((environment) => ids.has(environment.environmentId));
  }, [environments, threadRef.environmentId]);
  const target =
    targets.find((environment) => environment.environmentId === targetEnvironmentId) ??
    targets[0] ??
    null;
  const targetId = target?.environmentId ?? null;
  const sourceLabel = environmentLabel(threadRef.environmentId);

  const sourceProject = exported
    ? projects.find(
        (project) =>
          project.environmentId === threadRef.environmentId && project.id === exported.projectId,
      )
    : undefined;
  const projectPlan = useMemo(
    () =>
      exported && sourceProject && targetId
        ? planTransferProject({
            sourceProject,
            exportedIdentity: exported.repositoryIdentity,
            targetProjects: projects.filter((project) => project.environmentId === targetId),
          })
        : null,
    [exported, projects, sourceProject, targetId],
  );
  // One clear match is chosen for the user; with none or several they choose. Personal workspace
  // is the only option when no project on the target is this repository.
  const effectiveChoice =
    projectChoice ??
    (projectPlan
      ? (projectPlan.preselected?.id ??
        (projectPlan.candidates.length === 0 ? SCRATCH_CHOICE : null))
      : null);
  const chosenProject =
    projectPlan?.candidates.find((project) => project.id === effectiveChoice) ?? null;
  const transferTarget: TransferTarget | null =
    effectiveChoice === SCRATCH_CHOICE
      ? { kind: "scratch" }
      : chosenProject
        ? { kind: "project", projectId: chosenProject.id }
        : null;

  const modelChoice = useMemo(() => {
    if (!exported || targetId === null) return null;
    const providers =
      environments.find((environment) => environment.environmentId === targetId)?.serverConfig
        ?.providers ?? [];
    return pickTransferModel({
      source: exported.modelSelection,
      targetProviders: providers,
      targetProjectDefault: chosenProject?.defaultModelSelection ?? null,
    });
  }, [chosenProject, environments, exported, targetId]);

  // A retry of the same handoff reuses its id, so a lost response cannot import twice. Choosing
  // a different destination starts a new handoff with a new id.
  const [transferId, setTransferId] = useState(() => randomUUID());

  const workspace = exported ? describeTransferWorkspace(exported.workspace) : null;
  const acknowledged = workspace === null || !workspace.needsAcknowledgement || conversationOnly;
  const canContinue =
    exported !== null &&
    target !== null &&
    transferTarget !== null &&
    modelChoice?.selection != null &&
    acknowledged &&
    !continuing &&
    !pushing;

  const onPush = async () => {
    setPushing(true);
    setPushError(null);
    const result = await push.run({ actionId: randomUUID(), action: "push" });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setPushError(
          failureMessage(squashAtomCommandFailure(result), "Could not push the branch."),
        );
      }
      setPushing(false);
      return;
    }
    // The push changes what the target can fetch, so read the thread's state again.
    await loadExport({ reload: true });
    setPushing(false);
  };

  const unwrap = async <A,>(run: Promise<AtomCommandResult<A, unknown>>): Promise<A> => {
    const result = await run;
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    return result.value;
  };

  const onContinue = async () => {
    if (!exported || !target || !transferTarget || !modelChoice?.selection) return;
    const targetEnvironment = target.environmentId;
    setContinuing(true);
    setContinueError(null);
    try {
      const outcome = await executeContinueOn({
        transferId,
        exported,
        target: transferTarget,
        modelSelection: modelChoice.selection,
        sourceEnvironmentLabel: sourceLabel,
        ports: {
          ensureScratch: async (): Promise<ProjectId> =>
            (await unwrap(ensureScratch({ environmentId: targetEnvironment, input: {} })))
              .projectId,
          importThread: (input) =>
            unwrap(importTransfer({ environmentId: targetEnvironment, input })),
          settleSource: async () => {
            await unwrap(settleThread(threadRef));
          },
        },
      });
      const targetRef = scopeThreadRef(targetEnvironment, outcome.targetThreadId);
      if (outcome.settleError !== null) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Continued, but the original is still active",
            description: `The thread is open on ${environmentLabel(targetEnvironment)}. ${failureMessage(
              outcome.settleError,
              "The original thread on this environment could not be settled.",
            )}`,
          }),
        );
      }
      const ready = await waitForThreadShell(targetRef);
      onClose();
      if (!ready) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Thread continued",
            description: `It is on ${environmentLabel(targetEnvironment)}, but its data has not reached this client yet. Open it from the sidebar.`,
          }),
        );
        return;
      }
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(targetRef),
      });
    } catch (error) {
      setContinueError(
        failureMessage(
          error,
          `Could not continue this thread on ${environmentLabel(targetEnvironment)}.`,
        ),
      );
      setContinuing(false);
    }
  };

  const shownFiles = exported?.workspace.changedFiles.slice(0, FILE_LIST_LIMIT) ?? [];
  const hiddenFileCount = (exported?.workspace.changedFiles.length ?? 0) - shownFiles.length;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !continuing) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Continue On Another Environment</DialogTitle>
          <DialogDescription>
            {sourceThread ? `"${sourceThread.title}" ` : "This thread "}
            becomes a new thread on the environment you choose. The original is settled, and you can
            bring it back.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {exportState.kind === "loading" ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Spinner className="size-4" />
              Reading the thread…
            </div>
          ) : exportState.kind === "error" ? (
            <Alert variant="error">
              <AlertTitle>Cannot Continue This Thread</AlertTitle>
              <AlertDescription>{exportState.message}</AlertDescription>
            </Alert>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label>Environment</Label>
                <Select
                  value={targetId ?? ""}
                  disabled={continuing || targets.length < 2}
                  onValueChange={(value) => {
                    setTargetEnvironmentId(value as EnvironmentId);
                    setProjectChoice(null);
                    setTransferId(randomUUID());
                  }}
                >
                  <SelectTrigger aria-label="Environment">
                    <SelectValue>{target?.label ?? "No environment available"}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {targets.map((environment) => (
                      <SelectItem key={environment.environmentId} value={environment.environmentId}>
                        {environment.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label>Project</Label>
                <Select
                  value={effectiveChoice ?? ""}
                  disabled={continuing || projectPlan === null}
                  onValueChange={(value) => {
                    setProjectChoice(value);
                    setTransferId(randomUUID());
                  }}
                >
                  <SelectTrigger aria-label="Project">
                    <SelectValue>
                      {effectiveChoice === SCRATCH_CHOICE
                        ? "Personal Workspace"
                        : (chosenProject?.title ?? "Choose a project")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {(projectPlan?.candidates ?? []).map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.title}
                      </SelectItem>
                    ))}
                    <SelectItem value={SCRATCH_CHOICE}>Personal Workspace</SelectItem>
                  </SelectPopup>
                </Select>
                {projectPlan && projectPlan.candidates.length === 0 ? (
                  <p className="text-muted-foreground text-xs">
                    No project on {target?.label} is this repository, so the thread goes to its
                    personal workspace.
                  </p>
                ) : projectPlan && projectPlan.preselected === null ? (
                  <p className="text-muted-foreground text-xs">
                    More than one project on {target?.label} is this repository. Choose one.
                  </p>
                ) : null}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label>Model</Label>
                {modelChoice?.selection ? (
                  <p className="text-sm">
                    {modelChoice.selection.model}
                    {modelChoice.origin === "target_default" ? (
                      <span className="text-muted-foreground">
                        {" "}
                        (the default on {target?.label}; {exported?.modelSelection.model} is not
                        available there)
                      </span>
                    ) : null}
                  </p>
                ) : (
                  <p className="text-destructive-foreground text-sm">
                    {target?.label} has no enabled provider to run this thread.
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label>What Travels</Label>
                <p className="text-muted-foreground text-sm">
                  The conversation's messages. Tool calls and command output, attachments, and files
                  do not come along.
                </p>
              </div>

              {workspace ? (
                <div className="flex flex-col gap-2">
                  <Label>Working Tree</Label>
                  {workspace.kind === "not_a_repository" ? (
                    <p className="text-muted-foreground text-sm">
                      This thread's folder is not a git repository, so only the conversation
                      travels.
                    </p>
                  ) : null}
                  {workspace.kind === "clean" ? (
                    <p className="text-sm">
                      Branch <span className="font-mono">{exported?.workspace.branch}</span> is
                      committed and pushed
                      {exported?.workspace.headSha ? (
                        <>
                          {" "}
                          at{" "}
                          <span className="font-mono">
                            {exported.workspace.headSha.slice(0, 9)}
                          </span>
                        </>
                      ) : null}
                      . {target?.label} can fetch it.
                    </p>
                  ) : null}
                  {workspace.hasUnpushed ? (
                    <div className="flex flex-col gap-2">
                      <p className="text-sm">
                        {exported?.workspace.branch === null
                          ? "This work is on a detached HEAD, which cannot be pushed from here."
                          : !exported?.workspace.hasUpstream
                            ? `Branch ${exported?.workspace.branch} has never been pushed.`
                            : `Branch ${exported?.workspace.branch} has ${exported?.workspace.aheadCount} commit${exported?.workspace.aheadCount === 1 ? "" : "s"} that ${exported?.workspace.aheadCount === 1 ? "is" : "are"} not pushed.`}{" "}
                        {target?.label} cannot fetch{" "}
                        {exported?.workspace.aheadCount === 1 ? "it" : "them"} until the branch is
                        pushed.
                      </p>
                      {workspace.canPush ? (
                        <div>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={pushing || continuing}
                            onClick={() => void onPush()}
                          >
                            {pushing ? <Spinner className="size-3.5" /> : null}
                            Push Branch
                          </Button>
                        </div>
                      ) : exported?.workspace.isDefaultBranch ? (
                        <p className="text-muted-foreground text-xs">
                          This is the default branch. Push it from the Git menu, which asks first.
                        </p>
                      ) : null}
                      {pushError ? (
                        <p className="text-destructive-foreground text-xs">{pushError}</p>
                      ) : null}
                    </div>
                  ) : null}
                  {workspace.hasUncommitted ? (
                    <div className="flex flex-col gap-1">
                      <p className="text-sm">
                        {exported?.workspace.changedFiles.length} uncommitted file
                        {exported?.workspace.changedFiles.length === 1 ? "" : "s"} stay on{" "}
                        {sourceLabel}:
                      </p>
                      <ul className="max-h-32 overflow-y-auto font-mono text-muted-foreground text-xs">
                        {shownFiles.map((path) => (
                          <li key={path} className="truncate">
                            {path}
                          </li>
                        ))}
                        {hiddenFileCount > 0 ? <li>and {hiddenFileCount} more</li> : null}
                      </ul>
                    </div>
                  ) : null}
                  {workspace.needsAcknowledgement ? (
                    <label className="flex cursor-pointer items-start gap-2 text-sm">
                      <Checkbox
                        className="mt-0.5"
                        checked={conversationOnly}
                        disabled={continuing}
                        onCheckedChange={(checked) => setConversationOnly(checked === true)}
                      />
                      <span>Continue with the conversation only</span>
                    </label>
                  ) : null}
                </div>
              ) : null}

              {continueError ? (
                <Alert variant="error">
                  <AlertTitle>Could Not Continue</AlertTitle>
                  <AlertDescription>{continueError}</AlertDescription>
                </Alert>
              ) : null}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={continuing} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!canContinue} onClick={() => void onContinue()}>
            {continuing ? <Spinner className="size-3.5" /> : null}
            Continue
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
