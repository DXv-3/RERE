// CodeWrench ships one icon family: production and preview (nightly channel) builds and the
// served web client all use the claw set in assets/codewrench.
export const BRAND_ASSET_PATHS = {
  developmentIconComposerProject: "assets/dev/app-icon.icon",
  developmentIosIconPng: "assets/dev/blueprint-ios-1024.png",
  developmentUniversalIconPng: "assets/dev/blueprint-universal-1024.png",

  productionIconComposerProject: "assets/prod/app-icon.icon",
  productionIosIconPng: "assets/codewrench/codewrench-ios-1024.png",
  // The claw with no tile behind it, for loading screens that sit on the app's own background.
  productionMarkPng: "assets/codewrench/codewrench-mark-1024.png",
  productionMacIconPng: "assets/codewrench/codewrench-macos-1024.png",
  productionLinuxIconPng: "assets/codewrench/codewrench-universal-1024.png",
  productionWindowsIconIco: "assets/codewrench/codewrench-windows.ico",
  productionWebFaviconIco: "assets/codewrench/codewrench-web-favicon.ico",
  productionWebFavicon16Png: "assets/codewrench/codewrench-web-favicon-16x16.png",
  productionWebFavicon32Png: "assets/codewrench/codewrench-web-favicon-32x32.png",
  productionWebAppleTouchIconPng: "assets/codewrench/codewrench-web-apple-touch-180.png",

  nightlyIconComposerProject: "assets/nightly/app-icon.icon",
  nightlyIosIconPng: "assets/codewrench/codewrench-ios-1024.png",
  nightlyMacIconPng: "assets/codewrench/codewrench-macos-1024.png",
  nightlyLinuxIconPng: "assets/codewrench/codewrench-universal-1024.png",
  nightlyWindowsIconIco: "assets/codewrench/codewrench-windows.ico",
  nightlyWebFaviconIco: "assets/codewrench/codewrench-web-favicon.ico",
  nightlyWebFavicon16Png: "assets/codewrench/codewrench-web-favicon-16x16.png",
  nightlyWebFavicon32Png: "assets/codewrench/codewrench-web-favicon-32x32.png",
  nightlyWebAppleTouchIconPng: "assets/codewrench/codewrench-web-apple-touch-180.png",

  developmentDesktopIconPng: "assets/dev/blueprint-macos-1024.png",
  developmentWindowsIconIco: "assets/dev/blueprint-windows.ico",
  developmentWebFaviconIco: "assets/codewrench/codewrench-web-favicon.ico",
  developmentWebFavicon16Png: "assets/codewrench/codewrench-web-favicon-16x16.png",
  developmentWebFavicon32Png: "assets/codewrench/codewrench-web-favicon-32x32.png",
  developmentWebAppleTouchIconPng: "assets/codewrench/codewrench-web-apple-touch-180.png",
} as const;

export type WebAssetBrand = "development" | "nightly" | "production";

export const WEB_ASSET_CHANNELS = ["latest", "nightly"] as const;

export type WebAssetChannel = (typeof WEB_ASSET_CHANNELS)[number];

export function resolveWebAssetBrandForChannel(channel: WebAssetChannel): WebAssetBrand {
  return channel === "nightly" ? "nightly" : "production";
}

export function resolveWebAssetBrandForPackageVersion(version: string): WebAssetBrand {
  return /^[^-+]+-(?:nightly|preview)\./.test(version) ? "nightly" : "production";
}

export interface IconOverride {
  readonly sourceRelativePath: string;
  readonly targetRelativePath: string;
}

const WEB_ICON_TARGET_FILENAMES = {
  faviconIco: "favicon.ico",
  favicon16Png: "favicon-16x16.png",
  favicon32Png: "favicon-32x32.png",
  appleTouchIconPng: "apple-touch-icon.png",
} as const;

const WEB_ICON_SOURCE_PATHS_BY_BRAND = {
  development: {
    faviconIco: BRAND_ASSET_PATHS.developmentWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
  },
  nightly: {
    faviconIco: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.nightlyWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.nightlyWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng,
  },
  production: {
    faviconIco: BRAND_ASSET_PATHS.productionWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.productionWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.productionWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
  },
} as const satisfies Record<WebAssetBrand, Record<keyof typeof WEB_ICON_TARGET_FILENAMES, string>>;

export function resolveWebIconOverrides(
  brand: WebAssetBrand,
  targetDirectory: string,
): ReadonlyArray<IconOverride> {
  const sourcePaths = WEB_ICON_SOURCE_PATHS_BY_BRAND[brand];
  return [
    {
      sourceRelativePath: sourcePaths.faviconIco,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.faviconIco}`,
    },
    {
      sourceRelativePath: sourcePaths.favicon16Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.favicon16Png}`,
    },
    {
      sourceRelativePath: sourcePaths.favicon32Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.favicon32Png}`,
    },
    {
      sourceRelativePath: sourcePaths.appleTouchIconPng,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.appleTouchIconPng}`,
    },
  ];
}

export const DEVELOPMENT_ICON_OVERRIDES = resolveWebIconOverrides("development", "dist/client");

export const DEVELOPMENT_PUBLIC_ICON_OVERRIDES = resolveWebIconOverrides(
  "development",
  "apps/web/public",
);
