import type { CampaignApprovalMode } from "@t3tools/contracts";
import { useState } from "react";

import { Alert, AlertDescription } from "../ui/alert";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { CampaignConfirmDialog } from "./CampaignConfirmDialog";
import {
  MODE_OPTIONS,
  modeChangeConfirmation,
  modeDescription,
  modeLabel,
  type ModeScope,
} from "./campaigns.logic";

/** The value for "use the client's mode", which a campaign may fall back to. */
const INHERIT = "inherit";

/**
 * Which mode is in force, in words, and for an administrator the way to change it. A campaign may
 * follow its client or set its own; a client always has one. Modes that publish without asking
 * need a confirmation that spells out what will happen.
 */
export function CampaignModeControl({
  scope,
  mode,
  inheritedMode,
  overridden = false,
  isAdministrator,
  onChange,
  onChanged,
}: {
  readonly scope: ModeScope;
  /** The mode in force. */
  readonly mode: CampaignApprovalMode;
  /** For a campaign: the client's mode, shown as the "same as" choice. Absent for a client. */
  readonly inheritedMode?: CampaignApprovalMode;
  /** The campaign sets its own mode instead of following the client. */
  readonly overridden?: boolean;
  readonly isAdministrator: boolean;
  /** Null means "follow the client". Resolves to a message when the change failed. */
  readonly onChange: (mode: CampaignApprovalMode | null) => Promise<string | null>;
  readonly onChanged?: () => void;
}) {
  const [pending, setPending] = useState<CampaignApprovalMode | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = async (next: CampaignApprovalMode | null) => {
    setSaving(true);
    setError(null);
    const failure = await onChange(next);
    setSaving(false);
    if (failure !== null) {
      setError(failure);
      return false;
    }
    onChanged?.();
    return true;
  };

  const choose = (value: string) => {
    if (value === INHERIT) {
      void apply(null);
      return;
    }
    const next = MODE_OPTIONS.find((option) => option.mode === value)?.mode;
    if (next === undefined || next === mode) return;
    if (modeChangeConfirmation(next, scope) === null) void apply(next);
    else {
      setError(null);
      setPending(next);
    }
  };

  const confirmation = pending === null ? null : modeChangeConfirmation(pending, scope);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{modeLabel(mode)}.</span>{" "}
          {modeDescription(mode)}
        </p>
        {isAdministrator ? (
          <Select value={mode} onValueChange={(value) => choose(String(value))}>
            <SelectTrigger
              size="sm"
              className="w-44"
              aria-label={`Approval mode for ${scope.name}`}
              disabled={saving}
            >
              <SelectValue>{modeLabel(mode)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="start" alignItemWithTrigger={false}>
              {MODE_OPTIONS.map((option) => (
                <SelectItem hideIndicator key={option.mode} value={option.mode}>
                  <span className="flex flex-col">
                    <span>{option.label}</span>
                    <span className="text-xs text-muted-foreground">{option.description}</span>
                  </span>
                </SelectItem>
              ))}
              {inheritedMode !== undefined && overridden ? (
                <SelectItem hideIndicator value={INHERIT}>
                  <span className="flex flex-col">
                    <span>Same As Client</span>
                    <span className="text-xs text-muted-foreground">
                      Follow the client's choice, now {modeLabel(inheritedMode)}.
                    </span>
                  </span>
                </SelectItem>
              ) : null}
            </SelectPopup>
          </Select>
        ) : (
          <span className="text-xs text-muted-foreground">
            Only an administrator can change this.
          </span>
        )}
      </div>
      {error && pending === null ? (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <CampaignConfirmDialog
        open={pending !== null && confirmation !== null}
        title={confirmation?.title ?? ""}
        body={confirmation?.body ?? ""}
        confirmLabel={confirmation?.confirmLabel ?? "Confirm"}
        pending={saving}
        error={pending === null ? null : error}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending === null) return;
          void apply(pending).then((done) => {
            if (done) setPending(null);
          });
        }}
      />
    </div>
  );
}
