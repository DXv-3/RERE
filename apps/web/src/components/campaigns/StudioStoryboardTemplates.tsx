import type { StudioBrief, StudioScene } from "@t3tools/contracts";
import { useId, useState } from "react";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { STORYBOARD_TEMPLATES, storyboardTemplateScenes } from "./studio.logic";

export function StudioStoryboardTemplates({
  savedBrief,
  brandNotes,
  scenes,
  onChange,
}: {
  readonly savedBrief: StudioBrief;
  readonly brandNotes: string;
  readonly scenes: readonly StudioScene[];
  readonly onChange: (scenes: readonly StudioScene[]) => void;
}) {
  const id = useId();
  const [template, setTemplate] =
    useState<(typeof STORYBOARD_TEMPLATES)[number]["id"]>("product-demo");
  const [notice, setNotice] = useState("");
  const [proposal, setProposal] = useState<readonly StudioScene[] | null>(null);
  const duration = scenes.reduce((total, scene) => total + scene.durationSeconds, 0);
  const fits =
    proposal !== null &&
    scenes.length + proposal.length <= 30 &&
    duration + proposal.reduce((total, scene) => total + scene.durationSeconds, 0) <= 60;
  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <label htmlFor={id} className="text-sm font-medium">
        Start from a storyboard template
      </label>
      <p className="text-xs text-muted-foreground">
        Local, editable draft proposals using your saved brief and brand notes. Review all claims
        and customer quotes before use.
      </p>
      <div className="flex flex-wrap gap-2">
        <select
          id={id}
          className="rounded-md border border-input bg-background p-2 text-sm"
          value={template}
          onChange={(event) => {
            setTemplate(event.currentTarget.value as typeof template);
            setProposal(null);
            setNotice("");
          }}
        >
          {STORYBOARD_TEMPLATES.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setProposal(storyboardTemplateScenes(template, savedBrief, brandNotes, randomUUID));
            setNotice("");
          }}
        >
          Preview proposal
        </Button>
      </div>
      {proposal && (
        <div className="space-y-2">
          <ol className="space-y-1 text-xs">
            {proposal.map((scene) => (
              <li key={scene.id}>
                {scene.title} · {scene.durationSeconds}s
              </li>
            ))}
          </ol>
          <p className="text-xs text-muted-foreground">
            Append these scenes, then edit their prompts, narration and text in the storyboard. Save
            when ready. No generation is started.
          </p>
          {!fits && (
            <p className="text-xs">
              Make room first: the storyboard can contain at most 30 scenes and 60 seconds.
            </p>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={!fits}
              onClick={() => {
                onChange([...scenes, ...proposal]);
                setProposal(null);
                setNotice("Template scenes added to your editable draft.");
              }}
            >
              Append to draft
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setProposal(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}
      {notice && (
        <p role="status" className="text-xs">
          {notice}
        </p>
      )}
    </div>
  );
}
