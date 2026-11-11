/** One native turn boundary; omitted fields select the latest committed prefix. */
export interface StoredForkOptions {
  readonly beforeTurnId?: string;
  readonly throughTurnId?: string;
}

/** Core's indexed item projection, distinct from an original JSON record. */
export interface StoredItem {
  readonly id: string;
  readonly turnId: string;
  /** Exact unsigned native ordinal, without JavaScript number rounding. */
  readonly updatedAtOrdinal: string;
  readonly createdAtMs: number;
  readonly startedAtMs: number | null;
  readonly completedAtMs: number | null;
  readonly data: Record<string, unknown>;
}

export interface StoredTurn {
  readonly id: string;
  readonly status: 'completed' | 'interrupted' | 'failed' | 'in_progress';
  readonly error: Record<string, unknown> | null;
  /** Unix timestamp, seconds. */
  readonly startedAt: number | null;
  /** Unix timestamp, seconds. */
  readonly completedAt: number | null;
  readonly durationMs: number | null;
  readonly summaryItems: readonly StoredItem[];
}

export interface StoredTurnPage {
  readonly turns: readonly StoredTurn[];
  readonly nextCursor: string | null;
  /** Opposite-direction cursor; direction reversal on the next request. */
  readonly backwardsCursor: string | null;
}

export interface StoredItemPage {
  readonly items: readonly StoredItem[];
  readonly nextCursor: string | null;
  /** Opposite-direction cursor; direction reversal on the next request. */
  readonly backwardsCursor: string | null;
}

export interface StoredMatch {
  readonly turnId: string;
  readonly itemId: string;
  readonly snippet: string;
  /** UTF-16 code-unit positions within the returned snippet. */
  readonly snippetMatchRange: { readonly start: number; readonly end: number };
  /** Inclusive cursor for storedTurns at the matching turn. */
  readonly turnCursor: string;
}

export interface StoredMatchPage {
  readonly items: readonly StoredMatch[];
  readonly nextCursor: string | null;
}

interface ItemWire {
  id: string;
  turn_id: string;
  updated_at_ordinal: string;
  created_at_ms: number;
  started_at_ms: number | null;
  completed_at_ms: number | null;
  data_json: string;
}

interface TurnWire {
  id: string;
  status: StoredTurn['status'];
  error: StoredTurn['error'];
  started_at: number | null;
  completed_at: number | null;
  duration_ms: number | null;
  items: ItemWire[];
}

interface MatchWire {
  turn_id: string;
  item_id: string;
  snippet: string;
  snippet_match_range: StoredMatch['snippetMatchRange'];
  turn_cursor: string;
}

export function storedOptions(
  limit: number,
  cursor: string | undefined,
  direction: 'asc' | 'desc' = 'asc',
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new RangeError(
      'Stored history limit must be an integer from 1 to 1000',
    );
  if (cursor !== undefined && (typeof cursor !== 'string' || !cursor))
    throw new TypeError('Stored history cursor must be a nonempty string');
  if (direction !== 'asc' && direction !== 'desc')
    throw new TypeError('Stored history direction must be asc or desc');
  return { limit, cursor: cursor ?? null, descending: direction === 'desc' };
}

function item(raw: ItemWire): StoredItem {
  const data: unknown = JSON.parse(raw.data_json);
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new TypeError('Native stored item must contain a JSON object');
  return {
    id: raw.id,
    turnId: raw.turn_id,
    updatedAtOrdinal: raw.updated_at_ordinal,
    createdAtMs: raw.created_at_ms,
    startedAtMs: raw.started_at_ms,
    completedAtMs: raw.completed_at_ms,
    data: data as Record<string, unknown>,
  };
}

export function storedTurnPage(encoded: string): StoredTurnPage {
  const raw = JSON.parse(encoded) as {
    turns: TurnWire[];
    next_cursor: string | null;
    backwards_cursor: string | null;
  };
  return {
    turns: raw.turns.map((turn) => ({
      id: turn.id,
      status: turn.status,
      error: turn.error,
      startedAt: turn.started_at,
      completedAt: turn.completed_at,
      durationMs: turn.duration_ms,
      summaryItems: turn.items.map(item),
    })),
    nextCursor: raw.next_cursor,
    backwardsCursor: raw.backwards_cursor,
  };
}

export function storedItemPage(encoded: string): StoredItemPage {
  const raw = JSON.parse(encoded) as {
    items: ItemWire[];
    next_cursor: string | null;
    backwards_cursor: string | null;
  };
  return {
    items: raw.items.map(item),
    nextCursor: raw.next_cursor,
    backwardsCursor: raw.backwards_cursor,
  };
}

export function storedMatchPage(encoded: string): StoredMatchPage {
  const raw = JSON.parse(encoded) as {
    items: MatchWire[];
    next_cursor: string | null;
  };
  return {
    items: raw.items.map((match) => ({
      turnId: match.turn_id,
      itemId: match.item_id,
      snippet: match.snippet,
      snippetMatchRange: match.snippet_match_range,
      turnCursor: match.turn_cursor,
    })),
    nextCursor: raw.next_cursor,
  };
}
