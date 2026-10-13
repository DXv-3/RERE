import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId, type ProviderOptionSelection } from "@t3tools/contracts";

import type { ModelOption } from "../../lib/modelOptions";
import {
  canCommitPendingModel,
  favoritesFirst,
  modelFavoriteKey,
  modelMatchesCatalogQuery,
  openProviderKey,
  pendingModelAfterPress,
  providerKeyAfterToggle,
  providerSectionIsCollapsed,
  toggleModelFavorite,
} from "./thread-settings-sheet-state";

function modelOption(
  model: string,
  options: ReadonlyArray<ProviderOptionSelection> = [],
): ModelOption {
  return {
    key: `codex:${model}`,
    label: model,
    subtitle: "",
    providerKey: "codex",
    providerLabel: "Codex",
    providerDriver: "codex",
    isDefault: false,
    isLegacy: false,
    capabilities: null,
    selection: {
      instanceId: ProviderInstanceId.make("codex"),
      model,
      options,
    },
  };
}

describe("thread settings sheet state", () => {
  it("keeps favorites in catalog order ahead of other models", () => {
    const models = [
      modelOption("first"),
      modelOption("second"),
      modelOption("third"),
      modelOption("fourth"),
    ];
    const favorites = new Set([models[2]!.key, models[0]!.key]);

    expect(favoritesFirst(models, favorites).map((model) => model.selection.model)).toEqual([
      "first",
      "third",
      "second",
      "fourth",
    ]);
    expect(models.map((model) => model.selection.model)).toEqual([
      "first",
      "second",
      "third",
      "fourth",
    ]);
  });

  it("adds and removes favorites for one provider instance", () => {
    const codexModel = modelOption("shared");
    const otherProvider = ProviderInstanceId.make("codex_personal");
    const personalModel = {
      ...codexModel,
      key: modelFavoriteKey(otherProvider, "shared"),
      selection: { ...codexModel.selection, instanceId: otherProvider },
    };
    const favorites = toggleModelFavorite([], codexModel);

    expect(toggleModelFavorite(favorites, personalModel)).toEqual([
      { provider: ProviderInstanceId.make("codex"), model: "shared" },
      { provider: otherProvider, model: "shared" },
    ]);
    expect(toggleModelFavorite(favorites, codexModel)).toEqual([]);
  });

  it("matches visible model and provider terms", () => {
    const model = modelOption("gpt-next");

    expect(modelMatchesCatalogQuery({ model, providerLabel: "Codex", query: "NEXT" })).toBe(true);
    expect(modelMatchesCatalogQuery({ model, providerLabel: "Codex", query: "codex" })).toBe(true);
    expect(modelMatchesCatalogQuery({ model, providerLabel: "Codex", query: "claude" })).toBe(
      false,
    );
  });

  it("treats whitespace-only catalog searches as empty", () => {
    expect(
      modelMatchesCatalogQuery({
        model: modelOption("gpt-next"),
        providerLabel: "Codex",
        query: "   ",
      }),
    ).toBe(true);
  });

  it("matches the upstream provider's display name", () => {
    const model = {
      ...modelOption("opencode/claude-fable-5"),
      label: "Claude Fable 5",
      subtitle: "OpenCode Zen",
    };

    expect(modelMatchesCatalogQuery({ model, providerLabel: "OpenCode", query: " ZEN " })).toBe(
      true,
    );
    expect(modelMatchesCatalogQuery({ model, providerLabel: "OpenCode", query: "copilot" })).toBe(
      false,
    );
  });

  it("clears staging when the applied model is pressed", () => {
    expect(
      pendingModelAfterPress({
        current: modelOption("gpt-next"),
        pressed: modelOption("gpt-current"),
        pressedIsApplied: true,
      }),
    ).toBeNull();
  });

  it("preserves staged options when the highlighted model is pressed again", () => {
    const pending = modelOption("gpt-next", [{ id: "effort", value: "high" }]);

    expect(
      pendingModelAfterPress({
        current: pending,
        pressed: modelOption("gpt-next"),
        pressedIsApplied: false,
      }),
    ).toBe(pending);
  });

  it("stages a different model", () => {
    const pressed = modelOption("gpt-other");

    expect(
      pendingModelAfterPress({
        current: modelOption("gpt-next"),
        pressed,
        pressedIsApplied: false,
      }),
    ).toBe(pressed);
  });

  it("cannot save a staged model after sign-out removes it from the catalog", () => {
    const pending = modelOption("gemini-native");
    const group = { providerKey: "codex", providerLabel: "Codex", models: [pending] };

    expect(canCommitPendingModel(pending, [group])).toBe(true);
    expect(canCommitPendingModel(pending, [])).toBe(false);
    expect(
      canCommitPendingModel(pending, [
        {
          ...group,
          models: [{ ...pending, isUnavailable: true }],
        },
      ]),
    ).toBe(false);
  });

  it("opens only the provider holding the applied model until a header is tapped", () => {
    expect(openProviderKey({ override: undefined, appliedProviderKey: "codex" })).toBe("codex");
    expect(openProviderKey({ override: "claude", appliedProviderKey: "codex" })).toBe("claude");
    expect(openProviderKey({ override: null, appliedProviderKey: "codex" })).toBeNull();
    expect(openProviderKey({ override: undefined, appliedProviderKey: null })).toBeNull();
  });

  it("toggling a section closes the open one (accordion)", () => {
    expect(providerKeyAfterToggle({ openKey: "codex", toggled: "claude" })).toBe("claude");
    expect(providerKeyAfterToggle({ openKey: "codex", toggled: "codex" })).toBeNull();
    expect(providerKeyAfterToggle({ openKey: null, toggled: "codex" })).toBe("codex");
  });

  it("collapses every section but the open one, unless the list is narrowed", () => {
    const base = { openKey: "codex", isNarrowed: false };
    expect(providerSectionIsCollapsed({ ...base, providerKey: "codex" })).toBe(false);
    expect(providerSectionIsCollapsed({ ...base, providerKey: "claude" })).toBe(true);
    expect(providerSectionIsCollapsed({ ...base, providerKey: "claude", isNarrowed: true })).toBe(
      false,
    );
  });
});
