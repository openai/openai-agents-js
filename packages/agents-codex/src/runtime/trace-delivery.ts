/** Private credentials live only for the original snapshots in one callback. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { TraceEvent } from './telemetry';

type Route = { identity: string; headers: Record<string, string> };
type Delivery = {
  active: boolean;
  routes: Map<TraceEvent, { sequence: number; route: Route }>;
};
const delivery = new AsyncLocalStorage<Delivery>();

export async function invokeTraceDelivery(
  events: readonly TraceEvent[],
  routes: Record<string, Route> | undefined,
  callback: () => void | Promise<void>,
  stopped?: AbortSignal,
): Promise<void> {
  const owner: Delivery = { active: !stopped?.aborted, routes: new Map() };
  const retire = () => {
    owner.active = false;
    owner.routes.clear();
  };
  for (const event of events) {
    const route = routes?.[String(event.sequence)];
    if (owner.active && event.credential_required === true && route)
      owner.routes.set(event, { sequence: event.sequence, route });
  }
  routes = undefined;
  stopped?.addEventListener('abort', retire, { once: true });
  try {
    await delivery.run(owner, callback);
  } finally {
    retire();
    stopped?.removeEventListener('abort', retire);
  }
}

export function traceCredentialRoute(event: TraceEvent): Route | undefined {
  if (event.credential_required !== true) return undefined;
  const owner = delivery.getStore();
  const entry = owner?.active ? owner.routes.get(event) : undefined;
  const route = entry?.sequence === event.sequence ? entry.route : undefined;
  if (!route)
    throw new Error('Native trace credential delivery is unavailable');
  return route;
}
