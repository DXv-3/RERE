import type { EnvironmentId } from "@t3tools/contracts";
import { type FormEvent, useState } from "react";

import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { SettingsRow } from "./settingsLayout";
import { useAddSharedModel } from "./useAddSharedModel";

/**
 * The recipient's side of a model share: paste the code the owner sent and the provider is set up
 * for you. It does the same as adding a Claude provider by hand with the address and token as
 * environment variables, with the token kept as a sensitive value.
 */
export function AddSharedModelSection({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const addSharedModel = useAddSharedModel(environmentId);
  const [code, setCode] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSaving) return;
    setErrorMessage("");
    setIsSaving(true);
    const outcome = await addSharedModel(code);
    setIsSaving(false);
    if (!outcome.ok) {
      setErrorMessage(outcome.message);
      return;
    }
    // The code holds the token; do not leave it sitting in the page.
    setCode("");
    toastManager.add({
      type: "success",
      title: "Shared model added",
      description: `${outcome.displayName} is ready to choose in a new thread.`,
    });
  };

  return (
    <FoldedSettingsSection id="add-shared-model" title="Add a shared model" summary={null}>
      <SettingsRow
        title="Paste a share code"
        description="Someone shared a model with you? If they used your email, it appears here by itself once you are signed in. Otherwise paste the code they sent, starting with codewrench-share:. The model runs on their machine; you use it from here."
      >
        <form className="mt-3 space-y-3" onSubmit={(event) => void handleSubmit(event)}>
          <Textarea
            aria-label="Share code"
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            disabled={isSaving}
            onChange={(event) => setCode(event.currentTarget.value)}
            placeholder="codewrench-share:..."
            spellCheck={false}
            value={code}
          />
          {errorMessage ? (
            <Alert variant="error">
              <AlertDescription>{errorMessage}</AlertDescription>
            </Alert>
          ) : null}
          <Button disabled={isSaving || code.trim().length === 0} size="sm" type="submit">
            {isSaving ? "Adding..." : "Add Shared Model"}
          </Button>
        </form>
      </SettingsRow>
    </FoldedSettingsSection>
  );
}
