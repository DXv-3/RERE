import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { useProjects, useThreadShells } from "../../state/entities";
import { useProjectFilePickerQuery } from "../files/projectFilesQueryState";
import { getProjectFilePickerMatches } from "../files/ProjectFilePicker.logic";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { CampaignMediaThumb } from "./CampaignPostMedia";

const RESULTS_SHOWN = 8;

/**
 * The picture a video starts from. It shows the chosen picture as a thumbnail and lets the person
 * choose a different image from the chosen thread's folder. With no thread (the export folder)
 * there is no folder to look in, and it says so.
 */
export function FirstFramePicker({
  environmentId,
  threadId,
  value,
  disabled,
  inputId,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  /** The thread whose folder the picture comes from; undefined for the export folder. */
  readonly threadId: string | undefined;
  /** Relative to the thread's folder; empty when none is chosen. */
  readonly value: string;
  readonly disabled: boolean;
  readonly inputId: string;
  readonly onChange: (path: string) => void;
}) {
  const [choosing, setChoosing] = useState(false);
  const shells = useThreadShells();
  const projects = useProjects();
  const folder = useMemo(() => {
    const shell = shells.find(
      (candidate) => candidate.id === threadId && candidate.environmentId === environmentId,
    );
    if (shell === undefined) return null;
    const project = projects.find(
      (candidate) =>
        candidate.id === shell.projectId && candidate.environmentId === shell.environmentId,
    );
    return shell.worktreePath ?? project?.workspaceRoot ?? null;
  }, [shells, projects, threadId, environmentId]);

  return (
    <div className="space-y-2">
      <Label htmlFor={inputId}>Starting Picture</Label>
      <div className="flex items-center gap-3">
        <CampaignMediaThumb
          environmentId={environmentId}
          sourceThreadId={threadId}
          item={value === "" ? undefined : { kind: "path", value }}
          kind="image"
          className="size-20"
        />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="truncate text-sm">
            {value === "" ? "No picture chosen yet." : (value.split(/[\\/]/).at(-1) ?? value)}
          </p>
          <Button
            id={inputId}
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || folder === null}
            aria-expanded={choosing}
            onClick={() => setChoosing((current) => !current)}
          >
            {choosing
              ? "Close The List"
              : value === ""
                ? "Choose A Picture"
                : "Choose A Different Picture"}
          </Button>
        </div>
      </div>
      {folder === null ? (
        <p className="text-xs text-muted-foreground">
          Pick a thread under Save Files In to choose a picture from its folder. The export folder
          has no pictures to look through.
        </p>
      ) : choosing ? (
        <PictureList
          environmentId={environmentId}
          threadId={threadId}
          cwd={folder}
          current={value}
          onPick={(path) => {
            onChange(path);
            setChoosing(false);
          }}
        />
      ) : null}
    </div>
  );
}

function PictureList({
  environmentId,
  threadId,
  cwd,
  current,
  onPick,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string | undefined;
  readonly cwd: string;
  readonly current: string;
  readonly onPick: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const result = useProjectFilePickerQuery(environmentId, cwd, query, 60, { imageOnly: true });
  const matches = getProjectFilePickerMatches(result.entries, result.matchedQuery, RESULTS_SHOWN);
  return (
    <div className="space-y-2 rounded-md border border-border/60 p-2">
      <Input
        nativeInput
        aria-label="Search Pictures"
        placeholder="Search pictures in this folder"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      {matches.length === 0 ? (
        <p className="text-xs text-muted-foreground" role="status">
          {result.error
            ? "The pictures could not be listed."
            : result.isPending
              ? "Looking for pictures…"
              : query.trim() === ""
                ? "No pictures were found in this folder."
                : "No picture matches that."}
        </p>
      ) : (
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {matches.map((match) => (
            <li key={match.path}>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md p-1 text-start hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-muted"
                aria-pressed={match.path === current}
                onClick={() => onPick(match.path)}
              >
                <CampaignMediaThumb
                  environmentId={environmentId}
                  sourceThreadId={threadId}
                  item={{ kind: "path", value: match.path }}
                  className="size-10"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{match.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{match.path}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
