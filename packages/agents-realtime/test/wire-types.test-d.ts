import { expectTypeOf } from 'vitest';
import type { RealtimeServerEvent } from '../src/openaiRealtimeEvents';

expectTypeOf<
  Exclude<RealtimeServerEvent['type'], 'error' | `${string}.${string}`>
>().toEqualTypeOf<never>();
