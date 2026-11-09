import { rm } from 'node:fs/promises';
import type { Engine, _ProviderHttpTransports } from '../../native/index.js';
import type { NativeProviderRoutes } from './http-model';

export interface PrivateKernel {
  engine: Engine;
  carrier: NativeProviderRoutes;
  transports: _ProviderHttpTransports;
  home: { codex_home: string; cwd: string };
  apiKey: string;
  phase: 'engine' | 'carrier' | 'home' | 'done';
  nativeHome?: boolean;
  diagnostic?: string | null;
  pending?: Promise<string | null>;
}

export interface PrivateRuntimeBorrow {
  readonly done: boolean;
  peek(): PrivateKernel | undefined;
  bind(
    engine: Engine,
    carrier: NativeProviderRoutes,
    transports: _ProviderHttpTransports,
  ): void;
  reset(): Promise<{ codex_home: string; cwd: string }>;
  finish(keep: boolean): Promise<void>;
}

const grants = new WeakSet<object>();
const sessions = new WeakMap<object, PrivateRuntimeBorrow>();

export function privateOwnedGrant(): object {
  const value = {};
  grants.add(value);
  return value;
}

export function consumePrivateOwnedGrant(value: unknown): boolean {
  return typeof value === 'object' && value !== null && grants.delete(value);
}

export function revokePrivateOwnedGrant(value: unknown): void {
  if (typeof value === 'object' && value !== null) grants.delete(value);
}

export function attachPrivateRuntime(
  session: object,
  borrow: PrivateRuntimeBorrow,
): void {
  sessions.set(session, borrow);
}

export function privateRuntime(
  session: object,
): PrivateRuntimeBorrow | undefined {
  return sessions.get(session);
}

export async function finishPrivateRuntime(
  session: object,
  keep: boolean,
): Promise<void> {
  const borrow = sessions.get(session);
  if (!borrow) return;
  try {
    await borrow.finish(keep);
  } finally {
    if (borrow.done) sessions.delete(session);
  }
}

export function disposePrivateKernel(
  entry: PrivateKernel,
): Promise<string | null> {
  if (entry.pending) return entry.pending;
  const dispose = async () => {
    if (entry.phase === 'engine') {
      entry.diagnostic = await entry.engine._close_report();
      entry.phase = 'carrier';
    }
    if (entry.phase === 'carrier') {
      await entry.carrier.close();
      entry.phase = 'home';
    }
    if (entry.phase === 'home') {
      if (!entry.nativeHome)
        await rm(entry.home.codex_home, { recursive: true, force: true });
      entry.phase = 'done';
    }
    return entry.diagnostic ?? null;
  };
  entry.pending = dispose().finally(() => {
    entry.pending = undefined;
  });
  return entry.pending;
}
