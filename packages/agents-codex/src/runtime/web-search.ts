import type { JsonObject } from './binding';

/** Approximate user location for hosted Responses web search. */
export interface WebSearchLocation {
  /** Two-letter ISO country code. */
  country?: string;
  region?: string;
  city?: string;
  /** IANA time zone, for example `America/Chicago`. */
  timezone?: string;
}

/** Provider-hosted image result count and caption controls. */
export interface WebSearchImageSettings {
  maxResults?: number;
  caption?: boolean;
}

/** A fixed native search grant captured when a Session opens. */
export interface WebSearch {
  readonly kind: 'web_search';
  readonly mode: 'cached' | 'live';
  readonly route: 'standalone' | 'hosted';
  readonly searchContextSize?: 'low' | 'medium' | 'high';
  readonly allowedDomains?: readonly string[];
  readonly blockedDomains?: readonly string[];
  readonly location?: Readonly<WebSearchLocation>;
  readonly searchContentTypes?: readonly ('text' | 'image')[];
  readonly imageSettings?: Readonly<WebSearchImageSettings>;
}

export interface WebSearchOptions {
  mode?: WebSearch['mode'];
  route?: WebSearch['route'];
  /** Optional context budget for either route; omitted value: route default. */
  searchContextSize?: WebSearch['searchContextSize'];
  /** Hosted only. Domain names without a URL scheme, including their subdomains. */
  allowedDomains?: readonly string[];
  /** Hosted only. Domain names without a URL scheme, including their subdomains. */
  blockedDomains?: readonly string[];
  /** Hosted only. Approximate user location. */
  location?: WebSearchLocation;
  /** Hosted only. Omitted value: model default. */
  searchContentTypes?: WebSearch['searchContentTypes'];
  /** Hosted only. Omitted fields: provider defaults. */
  imageSettings?: WebSearchImageSettings;
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
        'searchContextSize',
        'allowedDomains',
        'blockedDomains',
        'location',
        'searchContentTypes',
        'imageSettings',
      ].includes(key)
    )
      throw new TypeError(`Unsupported WebSearch option: ${key}`);
  const {
    mode = 'cached',
    route = 'standalone',
    searchContextSize,
    allowedDomains,
    blockedDomains,
    location,
    searchContentTypes,
    imageSettings,
  } = options;
  if (mode !== 'cached' && mode !== 'live')
    throw new TypeError('WebSearch mode must be cached or live');
  if (route !== 'standalone' && route !== 'hosted')
    throw new TypeError('WebSearch route must be standalone or hosted');
  if (
    route === 'standalone' &&
    (allowedDomains !== undefined ||
      blockedDomains !== undefined ||
      location !== undefined ||
      searchContentTypes !== undefined ||
      imageSettings !== undefined)
  )
    throw new TypeError(
      'Unsupported WebSearch controls on the standalone route. Use route: hosted for domain filters, location, and image controls.',
    );
  const capturedImageSettings =
    imageSettings === undefined ? undefined : { ...imageSettings };
  // Native configuration uses signed 64-bit TOML integers.
  const maxResults = capturedImageSettings?.maxResults;
  if (
    maxResults !== undefined &&
    (!Number.isInteger(maxResults) || maxResults < 0 || maxResults >= 2 ** 63)
  )
    throw new RangeError(
      'WebSearch image maxResults must be a non-negative integer below 2**63',
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
    ...(searchContextSize === undefined ? {} : { searchContextSize }),
    ...(capturedAllowedDomains === undefined
      ? {}
      : { allowedDomains: capturedAllowedDomains }),
    ...(capturedBlockedDomains === undefined
      ? {}
      : { blockedDomains: capturedBlockedDomains }),
    ...(capturedLocation === undefined
      ? {}
      : { location: Object.freeze(capturedLocation) }),
    ...(searchContentTypes === undefined
      ? {}
      : { searchContentTypes: Object.freeze([...searchContentTypes]) }),
    ...(capturedImageSettings === undefined
      ? {}
      : { imageSettings: Object.freeze(capturedImageSettings) }),
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

/** @internal Project the captured search grant into native configuration. */
export function webSearchConfig(search: WebSearch | undefined): JsonObject {
  const config: JsonObject = {
    web_search: search?.mode ?? 'disabled',
    'features.standalone_web_search': search?.route === 'standalone',
  };
  if (search?.searchContextSize !== undefined)
    config['tools.web_search.context_size'] = search.searchContextSize;
  if (search?.allowedDomains !== undefined)
    config['tools.web_search.allowed_domains'] = [...search.allowedDomains];
  if (search?.blockedDomains !== undefined)
    config['tools.web_search.blocked_domains'] = [...search.blockedDomains];
  if (search?.location !== undefined)
    config['tools.web_search.location'] = { ...search.location };
  if (search?.searchContentTypes !== undefined)
    config['tools.web_search.search_content_types'] = [
      ...search.searchContentTypes,
    ];
  if (search?.imageSettings !== undefined)
    config['tools.web_search.image_settings'] = {
      ...(search.imageSettings.maxResults === undefined
        ? {}
        : { max_results: search.imageSettings.maxResults }),
      ...(search.imageSettings.caption === undefined
        ? {}
        : { caption: search.imageSettings.caption }),
    };
  return config;
}
