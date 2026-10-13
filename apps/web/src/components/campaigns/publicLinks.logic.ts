import {
  isCampaignServerMediaLink,
  type CampaignPost,
  type CampaignStorageState,
} from "@t3tools/contracts";

/**
 * Public links for a post's folder files: which have one, and what to say about the rest. A link is
 * what cloud storage gave a file when it was uploaded, or the address this server serves it at;
 * anyone who has it can open the file.
 */

export type FileLink =
  | { readonly state: "ready"; readonly url: string }
  | { readonly state: "missing" };

export const fileLink = (post: Pick<CampaignPost, "uploadedMedia">, path: string): FileLink => {
  const url = post.uploadedMedia[path];
  return url === undefined || url.trim() === "" ? { state: "missing" } : { state: "ready", url };
};

export interface PublicLinksState {
  /** Folder files that have a link, and how many there are in all. */
  readonly ready: number;
  readonly total: number;
  /** Whether "Get Public Links" should be offered at all. */
  readonly canGet: boolean;
  /** Whether "Stop Sharing" should be offered: this server is handing out some of the post's files. */
  readonly canStopSharing: boolean;
  /** One sentence on where things stand, or null when there is nothing to say. */
  readonly message: string | null;
}

export const STORAGE_OFF_MESSAGE =
  "Public links are switched off. An administrator can turn on cloud storage or sharing from this server in Settings, Connections, Campaign Cloud Storage.";

export function publicLinksState(input: {
  readonly post: Pick<CampaignPost, "mediaPaths" | "uploadedMedia" | "status">;
  readonly storage: Pick<CampaignStorageState, "mode">;
  readonly isAdministrator: boolean;
}): PublicLinksState {
  const { post, storage, isAdministrator } = input;
  const total = post.mediaPaths.length;
  const readyUrls = post.mediaPaths.flatMap((path) => {
    const link = fileLink(post, path);
    return link.state === "ready" ? [link.url] : [];
  });
  const ready = readyUrls.length;
  const fromServer = readyUrls.filter(isCampaignServerMediaLink).length;
  const canStopSharing = isAdministrator && fromServer > 0 && post.status !== "publishing";
  if (total === 0) return { ready, total, canGet: false, canStopSharing, message: null };
  if (storage.mode === "off") {
    const earlier =
      ready === 0
        ? ""
        : fromServer === 0
          ? " Links made earlier still work."
          : fromServer === ready
            ? " The links this server made do not work while sharing is off."
            : " Links made earlier still work, except the ones this server made.";
    return {
      ready,
      total,
      canGet: false,
      canStopSharing,
      message: `${STORAGE_OFF_MESSAGE}${earlier}`,
    };
  }
  if (!isAdministrator) {
    return {
      ready,
      total,
      canGet: false,
      canStopSharing,
      message:
        ready === total
          ? "Every file has a public link."
          : "Only an administrator can make public links.",
    };
  }
  if (post.status === "publishing") {
    return {
      ready,
      total,
      canGet: false,
      canStopSharing,
      message: "The post is being sent right now.",
    };
  }
  return {
    ready,
    total,
    canGet: ready < total,
    canStopSharing,
    message:
      ready === total
        ? "Every file has a public link. Anyone with a link can open the file."
        : storage.mode === "server"
          ? `${ready} of ${total} files have a public link. Getting links shares the rest from this server, and anyone with a link can open them.`
          : `${ready} of ${total} files have a public link. Getting links uploads the rest to your cloud storage, and anyone with a link can open them.`,
  };
}
