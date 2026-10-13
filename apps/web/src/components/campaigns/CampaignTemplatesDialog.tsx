import type { Campaign, CampaignClient } from "@t3tools/contracts";
import { ChevronLeftIcon } from "lucide-react";
import { useId, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import {
  CAMPAIGN_TEMPLATES,
  buildTemplateRequest,
  initialTemplateInputs,
  templateById,
  type TemplateContext,
  type TemplateId,
} from "./campaignTemplates.logic";
import { modeInForce } from "./campaigns.logic";

const TEMPLATE_COPIED_TEXT = "Copied. Paste it into a thread with an agent.";

/**
 * Four starting points for a campaign. Each asks for its two or three answers and makes a request
 * to paste into a thread with an agent. Nothing is sent from here: the app's only way to start a
 * thread sends at once, and a request should be read before it goes.
 */
export function CampaignTemplatesDialog({
  open,
  initialTemplate,
  ...props
}: {
  readonly open: boolean;
  /** Opens straight to this template instead of the list. */
  readonly initialTemplate: TemplateId | null;
  readonly campaign: Campaign;
  readonly client: CampaignClient | undefined;
  readonly onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && props.onClose()}>
      <DialogPopup className="max-w-xl">
        <TemplatesBody
          key={initialTemplate ?? "list"}
          initialTemplate={initialTemplate}
          {...props}
        />
      </DialogPopup>
    </Dialog>
  );
}

function TemplatesBody({
  initialTemplate,
  campaign,
  client,
  onClose,
}: {
  readonly initialTemplate: TemplateId | null;
  readonly campaign: Campaign;
  readonly client: CampaignClient | undefined;
  readonly onClose: () => void;
}) {
  const idBase = useId();
  const [selected, setSelected] = useState<TemplateId | null>(initialTemplate);
  const [inputs, setInputs] = useState<Record<string, string>>(
    initialTemplate === null ? {} : initialTemplateInputs(templateById(initialTemplate)),
  );
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [request, setRequest] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "the request",
    timeout: 6000,
    onError: () => setCopyFailed(true),
  });

  const template = selected === null ? null : templateById(selected);
  const choose = (id: TemplateId) => {
    setSelected(id);
    setInputs(initialTemplateInputs(templateById(id)));
    setProblems({});
    setRequest(null);
    setCopyFailed(false);
  };

  const copy = () => {
    if (selected === null) return;
    const context: TemplateContext = {
      clientId: campaign.clientId,
      clientName: client?.name ?? "this client",
      campaignId: campaign.id,
      campaignName: campaign.name,
      brandNotes: client?.brandNotes ?? "",
      doNotSay: client?.doNotSay ?? [],
      mode: modeInForce(client, campaign).mode,
    };
    const result = buildTemplateRequest(selected, inputs, context);
    if (!result.ok) {
      setProblems(result.problems);
      setRequest(null);
      return;
    }
    setProblems({});
    setCopyFailed(false);
    setRequest(result.text);
    copyToClipboard(result.text, undefined);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{template === null ? "Templates" : template.title}</DialogTitle>
        <DialogDescription>
          {template === null
            ? `Starting points for ${campaign.name}. Pick one, answer a couple of questions, and paste the request into a thread with an agent.`
            : template.summary}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {template === null ? (
          <ul className="flex flex-col divide-y divide-border/60">
            {CAMPAIGN_TEMPLATES.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className="flex w-full flex-col gap-0.5 rounded-sm py-2.5 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => choose(entry.id)}
                >
                  <span className="text-sm font-medium">{entry.title}</span>
                  <span className="text-xs text-muted-foreground">{entry.summary}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="space-y-4">
            {template.fields.map((field) => {
              const fieldId = `${idBase}-${field.id}`;
              const problem = problems[field.id];
              return (
                <div key={field.id} className="space-y-1.5">
                  <Label htmlFor={fieldId}>
                    {field.label}
                    {field.required ? "" : " (Optional)"}
                  </Label>
                  <Input
                    id={fieldId}
                    nativeInput
                    type={
                      field.kind === "number" ? "text" : field.kind === "month" ? "month" : "text"
                    }
                    inputMode={
                      field.kind === "number" ? "numeric" : field.kind === "url" ? "url" : undefined
                    }
                    placeholder={field.placeholder}
                    value={inputs[field.id] ?? ""}
                    aria-invalid={problem !== undefined}
                    aria-describedby={`${fieldId}-note`}
                    autoComplete="off"
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setInputs((current) => ({ ...current, [field.id]: value }));
                    }}
                  />
                  <p
                    id={`${fieldId}-note`}
                    role={problem === undefined ? undefined : "alert"}
                    className={
                      problem === undefined
                        ? "text-xs text-muted-foreground"
                        : "text-xs text-destructive-foreground"
                    }
                  >
                    {problem ?? field.hint}
                  </p>
                </div>
              );
            })}
            {request !== null ? (
              <div className="space-y-1.5">
                <p role="status" className="text-xs font-medium">
                  {copyFailed
                    ? "It could not be copied automatically. Select the text below and copy it."
                    : isCopied
                      ? TEMPLATE_COPIED_TEXT
                      : "Ready."}
                </p>
                <Label htmlFor={`${idBase}-request`} className="sr-only">
                  The request
                </Label>
                <Textarea
                  id={`${idBase}-request`}
                  readOnly
                  value={request}
                  className="max-h-56"
                  onFocus={(event) => event.currentTarget.select()}
                />
              </div>
            ) : null}
          </div>
        )}
      </DialogPanel>
      <DialogFooter>
        {template !== null ? (
          <Button
            type="button"
            variant="ghost-muted"
            className="sm:mr-auto"
            onClick={() => setSelected(null)}
          >
            <ChevronLeftIcon aria-hidden />
            All Templates
          </Button>
        ) : null}
        <Button type="button" variant="outline" onClick={onClose}>
          Close
        </Button>
        {template !== null ? (
          <Button type="button" onClick={copy}>
            {request === null ? "Copy Request" : "Copy Again"}
          </Button>
        ) : null}
      </DialogFooter>
    </>
  );
}
