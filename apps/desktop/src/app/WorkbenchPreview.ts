// A build-time flag keeps preview packaging separate from upstream development.
// Runtime environment variables cannot turn an installed preview into a T3 install.
declare const __WORKBENCH_PREVIEW__: boolean;
export const isWorkbenchPreview =
  typeof __WORKBENCH_PREVIEW__ !== "undefined" && __WORKBENCH_PREVIEW__;
export const desktopHomeVariable = isWorkbenchPreview ? "WORKBENCH_PREVIEW_HOME" : "T3CODE_HOME";

declare const __CODEWRENCH_UPDATE_FEED_URL__: string;
export const codewrenchUpdateFeedUrl =
  isWorkbenchPreview && typeof __CODEWRENCH_UPDATE_FEED_URL__ !== "undefined"
    ? __CODEWRENCH_UPDATE_FEED_URL__
    : "";
