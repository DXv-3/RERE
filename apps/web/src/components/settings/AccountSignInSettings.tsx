import { AccountSignInMode, type EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { SettingsRow } from "./settingsLayout";

const MODES = [
  { value: "off", label: "Off" },
  { value: "allowed", label: "Allowed" },
  { value: "required", label: "Required" },
] as const;

const isMode = Schema.is(AccountSignInMode);

/**
 * Whether this machine can be opened by signing in with the account it is linked to. Off keeps the
 * pairing code as the only way in. Existing sessions are not ended by changing it.
 */
export function AccountSignInSettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const mode = useEnvironmentSettings(environmentId, (settings) => settings.accountSignIn);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const current = MODES.find((option) => option.value === mode) ?? MODES[0];

  return (
    <FoldedSettingsSection id="account-sign-in" title="Account sign-in" summary={current.label}>
      <SettingsRow
        title="Open this environment with an account"
        description="Allowed adds Sign In beside the pairing code. Required makes signing in the first screen, on the desktop app too. Only the account this environment is linked to gets in, and a pairing link still works either way. It does nothing until the environment is linked to your account and the server knows the sign-in provider."
        control={
          <Select
            value={current.value}
            onValueChange={(value) => {
              if (isMode(value)) updateSettings({ accountSignIn: value });
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Account sign-in">
              <SelectValue>{current.label}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {MODES.map((option) => (
                <SelectItem hideIndicator key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </FoldedSettingsSection>
  );
}
