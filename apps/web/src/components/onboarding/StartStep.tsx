import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ClipboardPasteIcon,
  GiftIcon,
  UserIcon,
  WrenchIcon,
} from "lucide-react";
import { useEffect, useReducer, useState, type Dispatch, type ReactNode } from "react";

import { useAccountSession } from "../../cloud/accountSessionContext";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import {
  INITIAL_START_STATE,
  inspectShareCode,
  startReducer,
  type StartEvent,
  type StartState,
} from "../../onboarding/startChoice.logic";
import { useAccountSignInActions } from "../account/useAccountSignInActions";
import { useAddSharedModel } from "../settings/useAddSharedModel";
import { useSharedModelInvites } from "../settings/useSharedModelInvites";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

/** A shared model that was just added, ready to be the model of the first thread. */
export interface AddedSharedModel {
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
}

function ChoiceButton({
  icon,
  title,
  detail,
  onClick,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly detail: string;
  readonly onClick: () => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-background">
      <Button
        variant="ghost"
        size="sm-multiline"
        className="min-h-14 w-full justify-start"
        onClick={onClick}
      >
        {icon}
        <span className="flex-1 text-left">
          <span className="block text-sm font-medium">{title}</span>
          <span className="block text-xs font-normal text-muted-foreground">{detail}</span>
        </span>
        <ArrowRightIcon className="size-4 text-muted-foreground" />
      </Button>
    </div>
  );
}

function SignInChoice({ onSignedIn }: { readonly onSignedIn: () => void }) {
  const { isLoaded, isSignedIn } = useAccountSession();
  const { startSignIn } = useAccountSignInActions();
  return (
    <div className="rounded-lg border border-border bg-background">
      <Button
        variant="ghost"
        size="sm-multiline"
        className="min-h-14 w-full justify-start"
        disabled={!isLoaded}
        onClick={() => {
          // Signing in hands over to the browser; the next screen shows the signed-in account.
          if (!isSignedIn) startSignIn();
          onSignedIn();
        }}
      >
        <UserIcon className="size-4 text-muted-foreground" />
        <span className="flex-1 text-left">
          <span className="block text-sm font-medium">Sign in to my account</span>
          <span className="block text-xs font-normal text-muted-foreground">
            Use the computers and models linked to your account.
          </span>
        </span>
        <ArrowRightIcon className="size-4 text-muted-foreground" />
      </Button>
    </div>
  );
}

/**
 * Shown to someone who is signed in when another person shared a model with their email. Nothing
 * is added until they choose to continue, because this screen is where they decide how to start.
 */
function SharedWithYouChoice({
  environmentId,
  onStartWithShared,
}: {
  readonly environmentId: EnvironmentId;
  readonly onStartWithShared: (added: AddedSharedModel) => void;
}) {
  const { isLoaded, isSignedIn } = useAccountSession();
  const { pending, refresh, collect } = useSharedModelInvites(environmentId);
  const [adding, setAdding] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (isLoaded && isSignedIn) void refresh();
  }, [isLoaded, isSignedIn, refresh]);

  const first = pending[0];
  if (!first) return null;
  const models = pending.flatMap((invite) => invite.models);
  return (
    <>
      <ChoiceButton
        icon={<GiftIcon className="size-4 text-muted-foreground" />}
        title="A model was shared with you"
        detail={`${first.label} shared ${models.length === 1 ? models[0] : `${models.length} models`}. ${
          adding ? "Adding..." : "Continue to add it and start chatting."
        }`}
        onClick={() => {
          if (adding) return;
          setAdding(true);
          setFailed(false);
          void collect({ notify: false }).then((collected) => {
            setAdding(false);
            const added = collected[0];
            if (!added) {
              setFailed(true);
              return;
            }
            onStartWithShared({ instanceId: added.instanceId, model: added.models[0] ?? "" });
          });
        }}
      />
      {failed ? (
        <Alert variant="error">
          <AlertDescription>
            That model could not be added. Try again, or add it later in Settings.
          </AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

function ShareCodeForm({
  environmentId,
  state,
  dispatch,
  onStart,
}: {
  readonly environmentId: EnvironmentId;
  readonly state: StartState;
  readonly dispatch: Dispatch<StartEvent>;
  readonly onStart: (added: AddedSharedModel) => void;
}) {
  const addSharedModel = useAddSharedModel(environmentId);
  const [added, setAdded] = useState<AddedSharedModel | null>(null);
  const inspected = inspectShareCode(state.code);
  const adding = state.phase === "adding";

  if (state.phase === "added" && added !== null) {
    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">You’re all set</h1>
        <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
          {state.addedModels.length === 1 ? "This model is" : "These models are"} ready to use:
        </p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
          {state.addedModels.map((model) => (
            <li key={model}>{model}</li>
          ))}
        </ul>
        <div className="mt-6 flex items-center justify-end">
          <Button autoFocus onClick={() => onStart(added)}>
            Start Chatting
            <ArrowRightIcon className="size-3.5" />
          </Button>
        </div>
      </>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (adding) return;
        const code = state.code;
        dispatch({ type: "submit" });
        // The reducer shows why a code cannot be read; only a readable one reaches the server.
        const readable = inspectShareCode(code);
        if (readable === null || "error" in readable) return;
        void addSharedModel(code).then((outcome) => {
          if (outcome.ok) {
            setAdded({ instanceId: outcome.instanceId, model: outcome.models[0] ?? "" });
            dispatch({ type: "succeeded", models: outcome.models });
          } else dispatch({ type: "failed", message: outcome.message });
        });
      }}
    >
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        Paste your share code
      </h1>
      <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
        Paste the code you were sent. It starts with codewrench-share:
      </p>
      <Textarea
        autoFocus
        aria-label="Share code"
        autoCapitalize="none"
        autoComplete="off"
        autoCorrect="off"
        className="mt-4"
        disabled={adding}
        placeholder="codewrench-share:..."
        spellCheck={false}
        value={state.code}
        onChange={(event) => dispatch({ type: "edit", code: event.currentTarget.value })}
      />
      {inspected && "models" in inspected ? (
        <p className="mt-2 text-sm text-muted-foreground" role="status">
          Found {inspected.models.length === 1 ? "this model" : "these models"}:{" "}
          {inspected.models.join(", ")}
        </p>
      ) : null}
      {state.error ? (
        <Alert className="mt-3" variant="error">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="mt-6 flex items-center justify-between gap-3">
        <Button
          type="button"
          variant="ghost"
          disabled={adding}
          onClick={() => dispatch({ type: "back" })}
        >
          <ArrowLeftIcon className="size-3.5" />
          Back
        </Button>
        <Button type="submit" disabled={adding || state.code.trim().length === 0}>
          {adding ? "Adding..." : "Add Shared Model"}
        </Button>
      </div>
    </form>
  );
}

/**
 * "How do you want to start?" The three ways in for a new person: a share code from someone, an
 * account, or the existing provider setup. Only the share-code path has a screen of its own.
 */
export function StartStep({
  environmentId,
  onOwnProvider,
  onSignedIn,
  onStartWithShared,
}: {
  /** The computer the shared model is added to; null where there is none (the hosted app). */
  readonly environmentId: EnvironmentId | null;
  readonly onOwnProvider: () => void;
  readonly onSignedIn: () => void;
  readonly onStartWithShared: (added: AddedSharedModel) => void;
}) {
  const [state, dispatch] = useReducer(startReducer, INITIAL_START_STATE);
  if (state.phase !== "choice" && environmentId !== null) {
    return (
      <ShareCodeForm
        environmentId={environmentId}
        state={state}
        dispatch={dispatch}
        onStart={onStartWithShared}
      />
    );
  }
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        How do you want to start?
      </h1>
      <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
        Pick the one that fits. You can change this later in Settings.
      </p>
      <div className="mt-5 space-y-2">
        {environmentId !== null && hasCloudPublicConfig() ? (
          <SharedWithYouChoice
            environmentId={environmentId}
            onStartWithShared={onStartWithShared}
          />
        ) : null}
        {environmentId !== null ? (
          <ChoiceButton
            icon={<ClipboardPasteIcon className="size-4 text-muted-foreground" />}
            title="I have a share code from someone"
            detail="Paste it and start chatting."
            onClick={() => dispatch({ type: "openShare" })}
          />
        ) : null}
        {hasCloudPublicConfig() ? <SignInChoice onSignedIn={onSignedIn} /> : null}
        <ChoiceButton
          icon={<WrenchIcon className="size-4 text-muted-foreground" />}
          title="Set up my own AI provider"
          detail="Connect Claude, Codex or another provider yourself."
          onClick={onOwnProvider}
        />
      </div>
    </>
  );
}
