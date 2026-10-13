import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import type { ProviderInstanceId } from "@t3tools/contracts";

export type ModelFavorite = {
  readonly provider: ProviderInstanceId;
  readonly model: string;
};

export function modelFavoriteKey(provider: ProviderInstanceId, model: string): string {
  return `${provider}:${model}`;
}

export function toggleModelFavorite(
  favorites: ReadonlyArray<ModelFavorite>,
  option: ModelOption,
): ReadonlyArray<ModelFavorite> {
  const provider = option.selection.instanceId;
  const model = option.selection.model;
  return favorites.some((favorite) => favorite.provider === provider && favorite.model === model)
    ? favorites.filter((favorite) => favorite.provider !== provider || favorite.model !== model)
    : [...favorites, { provider, model }];
}

/** Keep catalog order within each group when favorites move to the front. */
export function favoritesFirst(
  models: ReadonlyArray<ModelOption>,
  favoriteKeys: ReadonlySet<string>,
): ReadonlyArray<ModelOption> {
  const favorites: ModelOption[] = [];
  const others: ModelOption[] = [];
  for (const model of models) {
    (favoriteKeys.has(model.key) ? favorites : others).push(model);
  }
  return [...favorites, ...others];
}

/** Match the terms a user can actually see or recognize in the model picker. */
export function modelMatchesCatalogQuery(input: {
  readonly model: ModelOption;
  readonly providerLabel: string;
  readonly query: string;
}): boolean {
  const query = input.query.trim().toLocaleLowerCase();
  if (query.length === 0) {
    return true;
  }

  return [
    input.model.label,
    input.model.subtitle,
    input.model.selection.model,
    input.providerLabel,
  ].some((value) => value.toLocaleLowerCase().includes(query));
}

/** Preserve staged provider options when the highlighted model is tapped again. */
export function pendingModelAfterPress(input: {
  readonly current: ModelOption | null;
  readonly pressed: ModelOption;
  readonly pressedIsApplied: boolean;
}): ModelOption | null {
  if (input.pressedIsApplied) {
    return null;
  }
  return input.current?.key === input.pressed.key ? input.current : input.pressed;
}

/** A model can disappear while the picker is open. */
export function canCommitPendingModel(
  pending: ModelOption,
  groups: ReadonlyArray<ProviderGroup>,
): boolean {
  return groups.some((group) =>
    group.models.some((model) => model.key === pending.key && !model.isUnavailable),
  );
}

/**
 * Accordion disclosure: at most one provider section is open. Until the user
 * taps a header (`override` is undefined) it is the provider holding the
 * applied model; after that it is whatever they last opened, or none (null).
 */
export function openProviderKey(input: {
  readonly override: string | null | undefined;
  readonly appliedProviderKey: string | null;
}): string | null {
  return input.override === undefined ? input.appliedProviderKey : input.override;
}

/** Tapping the open section closes it; tapping any other opens it and closes the rest. */
export function providerKeyAfterToggle(input: {
  readonly openKey: string | null;
  readonly toggled: string;
}): string | null {
  return input.openKey === input.toggled ? null : input.toggled;
}

/** A search query or provider filter shows every matching section expanded. */
export function providerSectionIsCollapsed(input: {
  readonly providerKey: string;
  readonly openKey: string | null;
  readonly isNarrowed: boolean;
}): boolean {
  return !input.isNarrowed && input.providerKey !== input.openKey;
}
