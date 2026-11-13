import type { ModelSettings } from './provider';

/** Select provider-owned HTTP history independently of local SDK storage. */
export type ProviderHistory =
  | { readonly type: 'conversation'; readonly id: string }
  | { readonly type: 'previous_response'; readonly id?: string };

export function captureProviderHistory(
  value: ProviderHistory | undefined,
): ProviderHistory | undefined {
  if (value === undefined) return undefined;
  if (value.type !== 'conversation' && value.type !== 'previous_response')
    throw new TypeError('Unsupported provider history selection');
  if (
    (value.type === 'conversation' || value.id !== undefined) &&
    (typeof value.id !== 'string' || !value.id.trim())
  )
    throw new TypeError('Provider history requires a nonempty ID');
  return Object.freeze(
    value.type === 'conversation'
      ? { type: value.type, id: value.id }
      : value.id === undefined
        ? { type: value.type }
        : { type: value.type, id: value.id },
  );
}

export function providerHistorySettings(
  history: ProviderHistory | undefined,
  settings: ModelSettings | undefined,
  websocketsAllowed = false,
): ModelSettings | undefined {
  if (history === undefined) return settings;
  if (
    history.type === 'previous_response' &&
    settings?.store !== true &&
    !websocketsAllowed
  )
    throw new TypeError(
      'Previous-response HTTP continuation requires store=true',
    );
  return { ...settings, store: settings?.store ?? null };
}
