import { z } from 'zod';
import { encodeReceipt, type NativeThread } from './binding';
import { nativeMarker, type NativeEvent } from './events';
import { NativeError } from './native-error';

const nativeCallbackReceipt = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('tool'),
      request: z
        .object({
          _sdk_python_tool: nativeMarker.strict(),
          turnId: z.string(),
          callId: z.string(),
        })
        .strict(),
      invocation: z.string().regex(/^(0|[1-9][0-9]*)$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal('preparation'),
      thread: z.string(),
      instance: z.string().optional(),
      id: z.string().regex(/^(0|[1-9][0-9]*)$/),
    })
    .strict(),
]);
export interface NativeCallbackDelivery {
  wire: string;
  native: NativeThread;
  controller: AbortController;
  claimed: boolean;
  buffered: boolean;
  retired: boolean;
  released: boolean;
}

/** Private receipt identity and lifetime for one Session's callback deliveries. */
export class CallbackDeliveries {
  private readonly callbackDeliveries = new Map<
    string,
    NativeCallbackDelivery
  >();
  private readonly callbackEvents = new WeakMap<
    NativeEvent,
    NativeCallbackDelivery
  >();

  get(event: NativeEvent): NativeCallbackDelivery | undefined {
    return this.callbackEvents.get(event);
  }

  cancel(native: NativeThread, receipt: unknown): void {
    const wire = encodeReceipt(nativeCallbackReceipt.parse(receipt));
    const delivery = this.callbackDeliveries.get(wire);
    if (delivery?.native === native) this.retire(delivery);
  }

  releaseUnclaimed(native: NativeThread): void {
    for (const delivery of this.callbackDeliveries.values())
      if (delivery.native === native && !delivery.claimed)
        this.release(delivery);
  }

  capture(
    native: NativeThread,
    receipt: unknown,
    event?: NativeEvent,
  ): NativeCallbackDelivery {
    const wire = encodeReceipt(nativeCallbackReceipt.parse(receipt));
    let delivery = this.callbackDeliveries.get(wire);
    if (!delivery) {
      delivery = {
        wire,
        native,
        controller: new AbortController(),
        claimed: false,
        buffered: false,
        retired: false,
        released: false,
      };
      this.callbackDeliveries.set(wire, delivery);
    } else if (delivery.native !== native) {
      throw new NativeError('Native callback receipt changed its owner');
    }
    if (event) this.callbackEvents.set(event, delivery);
    return delivery;
  }
  release(delivery: NativeCallbackDelivery, cleanupFailed = false): void {
    if (delivery.released) return;
    delivery.native._release_python_callback(delivery.wire, cleanupFailed);
    delivery.released = true;
    if (this.callbackDeliveries.get(delivery.wire) === delivery)
      this.callbackDeliveries.delete(delivery.wire);
  }
  retire(delivery: NativeCallbackDelivery): void {
    delivery.retired = true;
    delivery.controller.abort(new NativeError('Native callback cancelled'));
    if (!delivery.claimed) this.release(delivery);
  }
  authorityFailed(
    delivery: NativeCallbackDelivery | undefined,
    error: unknown,
  ): never {
    let cancelled = delivery?.retired ?? false;
    if (delivery && !cancelled) {
      try {
        cancelled = delivery.native._python_callback_cancelled(delivery.wire);
      } catch {
        throw error;
      }
    }
    if (delivery && cancelled) {
      this.retire(delivery);
      throw delivery.controller.signal.reason;
    }
    throw error;
  }
  async own(
    event: NativeEvent,
    owner: { readonly controller: AbortController },
    callback: (
      signal: AbortSignal,
      delivery?: NativeCallbackDelivery,
    ) => Promise<void>,
  ): Promise<void> {
    const delivery = this.callbackEvents.get(event);
    if (!delivery) return callback(owner.controller.signal);
    if (delivery.claimed || delivery.released) return;
    delivery.claimed = true;
    const signal = AbortSignal.any([
      owner.controller.signal,
      delivery.controller.signal,
    ]);
    let primary: { error: unknown } | undefined;
    try {
      // The outer owner registers this Promise before native claim or any
      // application validation, including synchronous policy callbacks.
      await Promise.resolve();
      if (
        !signal.aborted &&
        delivery.native._enter_python_callback(delivery.wire)
      )
        await callback(signal, delivery);
    } catch (error) {
      if (!(signal.aborted && Object.is(error, signal.reason)))
        primary = { error };
    } finally {
      try {
        this.release(delivery, primary !== undefined);
      } catch (error) {
        primary ??= { error };
      }
    }
    if (primary) throw primary.error;
  }
}
