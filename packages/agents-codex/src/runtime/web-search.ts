/** Approximate user location for hosted Responses web search. */
export interface WebSearchLocation {
  /** Two-letter ISO country code. */
  country?: string;
  region?: string;
  city?: string;
  /** IANA time zone, for example `America/Chicago`. */
  timezone?: string;
}

/** A fixed native search grant captured when a Session opens. */
export interface WebSearch {
  readonly kind: 'web_search';
  readonly mode: 'cached' | 'live';
  readonly route: 'standalone' | 'hosted';
  readonly allowedDomains?: readonly string[];
  readonly blockedDomains?: readonly string[];
  readonly location?: Readonly<WebSearchLocation>;
}

export interface WebSearchOptions {
  mode?: WebSearch['mode'];
  route?: WebSearch['route'];
  /** Hosted only. Domain names without a URL scheme, including their subdomains. */
  allowedDomains?: readonly string[];
  /** Hosted only. Domain names without a URL scheme, including their subdomains. */
  blockedDomains?: readonly string[];
  /** Hosted only. Approximate user location. */
  location?: WebSearchLocation;
}

/** Cached standalone search by default. Omission from tools disables search. */
export function webSearch(options: WebSearchOptions = {}): WebSearch {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('WebSearch options must be an object');
  for (const key of Object.keys(options))
    if (
      ![
        'mode',
        'route',
        'allowedDomains',
        'blockedDomains',
        'location',
      ].includes(key)
    )
      throw new TypeError(`Unsupported WebSearch option: ${key}`);
  const {
    mode = 'cached',
    route = 'standalone',
    allowedDomains,
    blockedDomains,
    location,
  } = options;
  if (mode !== 'cached' && mode !== 'live')
    throw new TypeError('WebSearch mode must be cached or live');
  if (route !== 'standalone' && route !== 'hosted')
    throw new TypeError('WebSearch route must be standalone or hosted');
  if (
    route === 'standalone' &&
    (allowedDomains !== undefined ||
      blockedDomains !== undefined ||
      location !== undefined)
  )
    throw new TypeError(
      'Unsupported WebSearch controls on the standalone route. Use route: hosted for domain filters and location.',
    );
  const capturedAllowedDomains = captureDomains(allowedDomains);
  const capturedBlockedDomains = captureDomains(blockedDomains);
  let capturedLocation: WebSearchLocation | undefined;
  if (location !== undefined) {
    if (!location || typeof location !== 'object' || Array.isArray(location))
      throw new TypeError('WebSearch location must be an object');
    capturedLocation = {};
    for (const key of ['country', 'region', 'city', 'timezone'] as const) {
      const value = location[key];
      if (value === undefined) continue;
      if (typeof value !== 'string')
        throw new TypeError(`WebSearch location ${key} must be a string`);
      capturedLocation[key] = value;
    }
  }
  return Object.freeze({
    kind: 'web_search',
    mode,
    route,
    ...(capturedAllowedDomains === undefined
      ? {}
      : { allowedDomains: capturedAllowedDomains }),
    ...(capturedBlockedDomains === undefined
      ? {}
      : { blockedDomains: capturedBlockedDomains }),
    ...(capturedLocation === undefined
      ? {}
      : { location: Object.freeze(capturedLocation) }),
  });
}

function captureDomains(domains: readonly string[] | undefined) {
  if (domains === undefined) return;
  if (!Array.isArray(domains))
    throw new TypeError('WebSearch domain filters must be arrays of strings');
  const captured = [...domains];
  if (captured.some((domain) => typeof domain !== 'string'))
    throw new TypeError('WebSearch domain filters must be arrays of strings');
  return Object.freeze(captured);
}

/** @internal Native policy identity; recorded calls never create this grant. */
export function webSearchName(search: WebSearch) {
  return search.route === 'standalone'
    ? { name: 'run', namespace: 'web' }
    : { name: 'web_search', namespace: 'functions' };
}
