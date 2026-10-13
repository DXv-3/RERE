import type {
  EnvironmentId,
  MediaError,
  MediaFrame,
  MediaProbe,
  MediaAnnotation,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  mediaAnnotationsSidecarPath,
  mergeMediaAnnotations,
  parseMediaAnnotationsSidecar,
  reconcileMediaAnnotationsForWrite,
  serializeMediaAnnotationsSidecar,
  setMediaAnnotationStatus,
  sortMediaAnnotations,
} from "@t3tools/shared/mediaAnnotations";
import { useCallback, useEffect, useRef, useState } from "react";

import { mediaEnvironment } from "~/state/media";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

/** Reads the `reason` a media request failed with, or null for anything else. */
function mediaErrorOf(error: unknown): Pick<MediaError, "reason" | "message"> | null {
  return typeof error === "object" &&
    error !== null &&
    "reason" in error &&
    typeof (error as { reason: unknown }).reason === "string"
    ? (error as Pick<MediaError, "reason" | "message">)
    : null;
}

export type MediaProbeState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly probe: MediaProbe }
  | {
      readonly status: "error";
      readonly reason: MediaError["reason"] | "unknown";
      readonly message: string;
    };

/** Facts about the file. Runs again when the file changes on disk (`revision`). */
export function useMediaProbe(input: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  revision: string | null;
}): MediaProbeState {
  const probeFile = useAtomCommand(mediaEnvironment.probe, { reportFailure: false });
  const [state, setState] = useState<MediaProbeState>({ status: "loading" });
  const { environmentId, cwd, relativePath, revision } = input;

  useEffect(() => {
    let active = true;
    void (async () => {
      const result = await probeFile({ environmentId, input: { cwd, relativePath } });
      if (!active) return;
      if (result._tag === "Success") {
        setState({ status: "ready", probe: result.value });
        return;
      }
      const error = squashAtomCommandFailure(result);
      const media = mediaErrorOf(error);
      setState({
        status: "error",
        reason: media?.reason ?? "unknown",
        message:
          media?.message ??
          (error instanceof Error ? error.message : "This file could not be read."),
      });
    })();
    return () => {
      active = false;
    };
  }, [cwd, environmentId, probeFile, relativePath, revision]);

  return state;
}

/** Timeline thumbnails, requested only once the viewer is up so they never delay opening it. */
export function useMediaThumbnails(input: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  count: number;
  /** Null until the file's facts are known; images and failed probes never ask. */
  enabled: boolean;
  revision: string | null;
}): ReadonlyArray<MediaFrame> | null {
  const thumbnails = useAtomCommand(mediaEnvironment.thumbnails, { reportFailure: false });
  const [frames, setFrames] = useState<ReadonlyArray<MediaFrame> | null>(null);
  const { environmentId, cwd, relativePath, count, enabled, revision } = input;

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void (async () => {
      const result = await thumbnails({ environmentId, input: { cwd, relativePath, count } });
      if (!active) return;
      // A failure leaves the strip empty; the video itself still plays and scrubs.
      setFrames(result._tag === "Success" ? result.value.frames : null);
    })();
    return () => {
      active = false;
    };
  }, [count, cwd, enabled, environmentId, relativePath, revision, thumbnails]);

  return enabled ? frames : null;
}

export type SidecarPersistence = "loading" | "saved" | "saving" | "memory" | "unreadable";

export interface MediaAnnotationsController {
  readonly annotations: ReadonlyArray<MediaAnnotation>;
  readonly persistence: SidecarPersistence;
  /** Plain words for the person when notes are not being saved beside the file. */
  readonly notice: string | null;
  readonly add: (annotation: MediaAnnotation) => void;
  readonly remove: (id: string) => void;
  readonly setStatus: (id: string, status: "open" | "resolved") => void;
}

/**
 * Review notes for one file, kept in `<file>.annotations.json` through the workspace file
 * commands (same path rules as the file panel; writes never leave the folder). If the folder
 * refuses the write, notes stay in memory for the session and `notice` says so. A sidecar this
 * build cannot read is never overwritten.
 */
export function useMediaAnnotationsSidecar(input: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  /** Changes when the workspace changes on disk, so an agent's edits to the notes show up. */
  revision: string | null;
}): MediaAnnotationsController {
  const { environmentId, cwd, relativePath, revision } = input;
  const sidecarPath = mediaAnnotationsSidecarPath(relativePath);
  const readFile = useAtomQueryRunner(projectEnvironment.readFile, {
    reportFailure: false,
    reportDefect: false,
    refresh: true,
  });
  const writeFile = useAtomCommand(projectEnvironment.writeFile, {
    reportFailure: false,
    reportDefect: false,
  });
  const [annotations, setAnnotations] = useState<ReadonlyArray<MediaAnnotation>>([]);
  const [persistence, setPersistence] = useState<SidecarPersistence>("loading");
  const [notice, setNotice] = useState<string | null>(null);
  const annotationsRef = useRef<ReadonlyArray<MediaAnnotation>>([]);
  const removedIdsRef = useRef(new Set<string>());
  const statusChangedIdsRef = useRef(new Set<string>());
  const blockedRef = useRef(false);
  const memoryOnlyRef = useRef(false);
  const writeChainRef = useRef<Promise<void>>(Promise.resolve());

  const publish = useCallback((next: ReadonlyArray<MediaAnnotation>) => {
    annotationsRef.current = next;
    setAnnotations(next);
  }, []);

  const readDisk = useCallback(async () => {
    const result = await readFile({ environmentId, input: { cwd, relativePath: sidecarPath } });
    // No file yet is the normal first state; the read failing is not told apart from it.
    if (result._tag !== "Success") return { kind: "missing" as const };
    return { kind: "read" as const, parsed: parseMediaAnnotationsSidecar(result.value.contents) };
  }, [cwd, environmentId, readFile, sidecarPath]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const disk = await readDisk();
      if (!active) return;
      if (disk.kind === "read" && disk.parsed.status !== "ok") {
        blockedRef.current = true;
        setPersistence("unreadable");
        setNotice(
          disk.parsed.status === "newer-version"
            ? "The notes file beside this file was written by a newer version, so new notes are kept for this session only."
            : "The notes file beside this file could not be read, so new notes are kept for this session only.",
        );
        return;
      }
      blockedRef.current = false;
      if (disk.kind === "read" && disk.parsed.status === "ok") {
        publish(mergeMediaAnnotations(disk.parsed.annotations, annotationsRef.current));
      }
      if (!memoryOnlyRef.current) {
        setPersistence("saved");
        setNotice(null);
      }
    })();
    return () => {
      active = false;
    };
    // Load again for another file, or when the workspace changes underneath this one.
  }, [publish, readDisk, revision]);

  const persist = useCallback(() => {
    if (blockedRef.current) return;
    writeChainRef.current = writeChainRef.current.then(async () => {
      if (blockedRef.current || memoryOnlyRef.current) return;
      setPersistence("saving");
      const disk = await readDisk();
      const onDisk =
        disk.kind === "read" && disk.parsed.status === "ok" ? disk.parsed.annotations : [];
      const merged = reconcileMediaAnnotationsForWrite({
        onDisk,
        local: annotationsRef.current,
        removedIds: removedIdsRef.current,
        statusChangedIds: statusChangedIdsRef.current,
      });
      const result = await writeFile({
        environmentId,
        input: {
          cwd,
          relativePath: sidecarPath,
          contents: serializeMediaAnnotationsSidecar(sortMediaAnnotations(merged)),
        },
      });
      if (result._tag === "Success") {
        setPersistence("saved");
        return;
      }
      memoryOnlyRef.current = true;
      setPersistence("memory");
      setNotice(
        "Could not save notes beside the file (the folder may be read-only), so they are kept for this session only.",
      );
    });
  }, [cwd, environmentId, readDisk, sidecarPath, writeFile]);

  const add = useCallback(
    (annotation: MediaAnnotation) => {
      removedIdsRef.current.delete(annotation.id);
      publish([
        ...annotationsRef.current.filter((entry) => entry.id !== annotation.id),
        annotation,
      ]);
      persist();
    },
    [persist, publish],
  );
  const remove = useCallback(
    (id: string) => {
      removedIdsRef.current.add(id);
      publish(annotationsRef.current.filter((entry) => entry.id !== id));
      persist();
    },
    [persist, publish],
  );
  const setStatus = useCallback(
    (id: string, status: "open" | "resolved") => {
      statusChangedIdsRef.current.add(id);
      publish(
        setMediaAnnotationStatus(annotationsRef.current, id, status, new Date().toISOString()),
      );
      persist();
    },
    [persist, publish],
  );

  return { annotations, persistence, notice, add, remove, setStatus };
}
