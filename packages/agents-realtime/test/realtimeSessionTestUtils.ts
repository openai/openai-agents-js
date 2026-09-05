import { once } from 'node:events';

export async function waitForEvent<T extends unknown[]>(
  emitter: object,
  eventName: string,
): Promise<T> {
  return (await once(emitter as any, eventName)) as T;
}
