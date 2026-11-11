/** Private credentials live only for the original snapshots in one callback. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { TraceEvent } from './telemetry';

type Route = { identity: string; headers: Record<string, string> };
type PrivateRoute = Route & { processor_ids: readonly string[] };
type Delivery = {
  active: boolean;
  stopped?: AbortSignal;
  routes: Map<TraceEvent, { sequence: number; route: Route | undefined }>;
};
const delivery = new AsyncLocalStorage<Delivery>();

export async function invokeTraceDelivery(
  events: readonly TraceEvent[],
  routes: Record<string, PrivateRoute> | undefined,
  processorId: string,
  callback: () => void | Promise<void>,
  stopped?: AbortSignal,
): Promise<void> {
  const owner: Delivery = {
    active: !stopped?.aborted,
    stopped,
    routes: new Map(),
  };
  const retire = () => {
    owner.active = false;
    owner.routes.clear();
  };
  for (const event of events) {
    const route = routes?.[String(event.sequence)];
    if (owner.active && event.credential_required === true && route) {
      // Only a live callback's original snapshot can use an explicit fallback.
      owner.routes.set(event, {
        sequence: event.sequence,
        route: route.processor_ids.includes(processorId) ? route : undefined,
      });
    }
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

/** SDK-owned exporter work shares the host pump's terminal cancellation. */
export function traceDeliverySignal(): AbortSignal | undefined {
  return delivery.getStore()?.stopped;
}

export function traceCredentialRoute(event: TraceEvent): Route | undefined {
  if (event.credential_required !== true) return undefined;
  const owner = delivery.getStore();
  const entry = owner?.active ? owner.routes.get(event) : undefined;
  if (!entry || entry.sequence !== event.sequence)
    throw new Error('Native trace credential delivery is unavailable');
  return entry.route;
}
