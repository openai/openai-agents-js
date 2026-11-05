/** A fixed native search grant captured when a Session opens. */
export interface WebSearch {
  readonly kind: 'web_search';
  readonly mode: 'cached' | 'live';
  readonly route: 'standalone' | 'hosted';
}

export interface WebSearchOptions {
  mode?: WebSearch['mode'];
  route?: WebSearch['route'];
}

/** Cached standalone search by default. Omission from tools disables search. */
export function webSearch(options: WebSearchOptions = {}): WebSearch {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('WebSearch options must be an object');
  for (const key of Object.keys(options))
    if (key !== 'mode' && key !== 'route')
      throw new TypeError(`Unsupported WebSearch option: ${key}`);
  const mode = options.mode === undefined ? 'cached' : options.mode;
  const route = options.route === undefined ? 'standalone' : options.route;
  if (mode !== 'cached' && mode !== 'live')
    throw new TypeError('WebSearch mode must be cached or live');
  if (route !== 'standalone' && route !== 'hosted')
    throw new TypeError('WebSearch route must be standalone or hosted');
  return Object.freeze({ kind: 'web_search', mode, route });
}

/** @internal Native policy identity; recorded calls never create this grant. */
export function webSearchName(search: WebSearch) {
  return search.route === 'standalone'
    ? { name: 'run', namespace: 'web' }
    : { name: 'web_search', namespace: 'functions' };
}
