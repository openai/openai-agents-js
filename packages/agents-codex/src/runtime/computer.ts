import { z } from 'zod';
import { FunctionAdmission } from './function-admission';
import {
  _nativeToolSessionOwner,
  createComputerTool,
  type FunctionTool,
  type ToolCallContext,
} from './tools';
import { losslessJsonObjectSchema, type JsonValue } from './binding';

type MaybePromise<T> = T | Promise<T>;
export type ComputerButton = 'left' | 'right' | 'wheel' | 'back' | 'forward';
export type ComputerEnvironment = 'mac' | 'windows' | 'ubuntu' | 'browser';

/** A borrowed driver. Screenshots return base64 PNG data; methods may observe cancellation. */
export interface Computer<Context = unknown> {
  readonly dimensions?: readonly [number, number];
  readonly environment?: ComputerEnvironment;
  initRun?(context: ToolCallContext<Context>): MaybePromise<void>;
  screenshot(context: ToolCallContext<Context>): MaybePromise<string>;
  click(
    x: number,
    y: number,
    button: ComputerButton,
    context: ToolCallContext<Context>,
  ): MaybePromise<void>;
  doubleClick(
    x: number,
    y: number,
    context: ToolCallContext<Context>,
  ): MaybePromise<void>;
  scroll(
    x: number,
    y: number,
    scrollX: number,
    scrollY: number,
    context: ToolCallContext<Context>,
  ): MaybePromise<void>;
  type(text: string, context: ToolCallContext<Context>): MaybePromise<void>;
  wait(context: ToolCallContext<Context>): MaybePromise<void>;
  move(
    x: number,
    y: number,
    context: ToolCallContext<Context>,
  ): MaybePromise<void>;
  keypress(
    keys: string[],
    context: ToolCallContext<Context>,
  ): MaybePromise<void>;
  drag(
    path: [number, number][],
    context: ToolCallContext<Context>,
  ): MaybePromise<void>;
}

/** Acquire once per Session. Dispose runs once after entered callbacks join.
 * Without dispose, policies run before first creation and again under the resolved
 * shared device gate before any action or screenshot.
 */
export interface ComputerProvider<Context = unknown> {
  create(context: ToolCallContext<Context>): MaybePromise<Computer<Context>>;
  dispose?(computer: Computer<Context>): MaybePromise<void>;
}

export class ComputerSafetyError extends Error {
  constructor(
    message = 'Pending computer safety checks require acknowledgment',
  ) {
    super(message);
    this.name = 'ComputerSafetyError';
  }
}

const coordinate = { x: z.number(), y: z.number() };
const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('screenshot') }),
  z.object({
    type: z.literal('click'),
    ...coordinate,
    button: z.enum(['left', 'right', 'wheel', 'back', 'forward']),
  }),
  z.object({ type: z.literal('double_click'), ...coordinate }),
  z.object({
    type: z.literal('scroll'),
    ...coordinate,
    scroll_x: z.number(),
    scroll_y: z.number(),
  }),
  z.object({ type: z.literal('type'), text: z.string() }),
  z.object({ type: z.literal('wait') }),
  z.object({ type: z.literal('move'), ...coordinate }),
  z.object({ type: z.literal('keypress'), keys: z.array(z.string()) }),
  z.object({ type: z.literal('drag'), path: z.array(z.object(coordinate)) }),
]);
export type ComputerAction = z.infer<typeof actionSchema>;
const callSchema = z.object({
  type: z.literal('computer_call'),
  call_id: z.string().min(1),
  action: actionSchema.nullish(),
  actions: z.array(actionSchema).nullish(),
  pending_safety_checks: z.array(losslessJsonObjectSchema).default([]),
});

export interface ComputerToolOptions<Context = unknown> {
  computer: Computer<Context> | ComputerProvider<Context>;
  toolType?: 'computer' | 'computer_use_preview';
  dimensions?: readonly [number, number];
  environment?: ComputerEnvironment;
  /** When supplied, must return true for every call, including calls without pending checks. */
  approve?: (
    context: ToolCallContext<Context>,
    actions: readonly ComputerAction[],
  ) => MaybePromise<boolean>;
  /** Only literal true acknowledges all original checks before any driver effects. */
  onSafetyCheck?: (
    context: ToolCallContext<Context>,
    checks: readonly Readonly<Record<string, unknown>>[],
  ) => MaybePromise<boolean>;
}

type Lease = {
  readonly gate: FunctionAdmission;
  driver?: Computer<any>;
  dispose?: (driver: Computer<any>) => MaybePromise<void>;
  initialized: boolean;
  initializationFailure?: { error: unknown };
};
const resources = new WeakMap<object, Map<object, Lease>>();
const borrowedGates = new WeakMap<object, FunctionAdmission>();
function deviceAdmission(computer: object): FunctionAdmission {
  let gate = borrowedGates.get(computer);
  if (!gate) {
    gate = new FunctionAdmission(1);
    borrowedGates.set(computer, gate);
  }
  return gate;
}

/** @internal Called only after the Session's callback owners retire. */
export async function closeComputerResources(owner: object): Promise<void> {
  const leases = resources.get(owner);
  if (!leases) return;
  resources.delete(owner);
  const errors: unknown[] = [];
  for (const lease of leases.values()) {
    const { driver, dispose } = lease;
    lease.driver = undefined;
    lease.dispose = undefined;
    if (driver && dispose) {
      try {
        await dispose(driver);
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length)
    throw new AggregateError(errors, 'Computer disposal failed');
}

/** A true native computer declaration. Core owns accepted history and continuation. */
export function computerTool<Context = unknown>(
  options: ComputerToolOptions<Context>,
): FunctionTool<Context> {
  const { computer, onSafetyCheck, approve } = options;
  const provider = 'create' in computer ? computer : undefined;
  const borrowed = provider ? undefined : (computer as Computer<Context>);
  const borrowedGate = borrowed && deviceAdmission(borrowed);
  const dimensions = options.dimensions ?? borrowed?.dimensions;
  const environment = options.environment ?? borrowed?.environment;
  const toolType = options.toolType ?? 'computer';
  if (toolType === 'computer_use_preview' && (!dimensions || !environment))
    throw new TypeError('Preview computer requires dimensions and environment');
  const declaration = {
    type: 'computer',
    toolType,
    ...(dimensions
      ? { displayWidth: dimensions[0], displayHeight: dimensions[1] }
      : {}),
    ...(environment ? { environment } : {}),
  };
  const identity = Object.freeze({});
  return createComputerTool<Context>(
    declaration,
    async (raw, context, admit, reportFailure) => {
      admit();
      // Validate the entire sequence before the first device effect.
      const owner = _nativeToolSessionOwner(context);
      const call = callSchema.parse(raw);
      const actions = call.actions?.length
        ? call.actions
        : call.action
          ? [call.action]
          : [];
      const pending = structuredClone(call.pending_safety_checks);
      let leases = resources.get(owner);
      if (!leases) resources.set(owner, (leases = new Map()));
      let lease = leases.get(identity);
      if (!lease) {
        lease = {
          gate: borrowedGate ?? new FunctionAdmission(1),
          initialized: false,
        };
        leases.set(identity, lease);
      }
      const authorize = async () => {
        admit();
        if (approve) {
          const allowed = await approve(context, structuredClone(actions));
          admit();
          if (allowed !== true)
            throw new ComputerSafetyError('Computer call was not approved');
        }
        if (pending.length) {
          if (!onSafetyCheck) throw new ComputerSafetyError();
          const acknowledged = await onSafetyCheck(
            context,
            structuredClone(pending),
          );
          admit();
          if (acknowledged !== true) throw new ComputerSafetyError();
        }
      };
      const release = await lease.gate.acquire(context.signal);
      let releaseDevice: (() => void) | undefined;
      try {
        const borrowedFactory = provider !== undefined && !provider.dispose;
        const resolving = borrowedFactory && !lease.driver;
        if (borrowedFactory && lease.driver)
          releaseDevice = await deviceAdmission(lease.driver).acquire(
            context.signal,
          );
        await authorize();
        if (!lease.driver) {
          // Retain ownership before checking cancellation after acquisition.
          lease.driver = provider ? await provider.create(context) : borrowed;
          lease.dispose = provider?.dispose
            ? (driver) => provider.dispose!(driver)
            : undefined;
          admit();
        }
        const driver = lease.driver;
        if (!driver)
          throw new TypeError('ComputerProvider.create must return a driver');
        if (resolving) {
          releaseDevice = await deviceAdmission(driver).acquire(context.signal);
          await authorize();
        }
        if (lease.initializationFailure)
          throw lease.initializationFailure.error;
        if (!lease.initialized) {
          lease.initialized = true;
          try {
            await driver.initRun?.(context);
            admit();
          } catch (error) {
            lease.initializationFailure = { error };
            throw error;
          }
        }
        let screenshot: string | undefined;
        for (const action of actions) {
          admit();
          screenshot = undefined;
          switch (action.type) {
            case 'screenshot':
              screenshot = await driver.screenshot(context);
              break;
            case 'click':
              await driver.click(action.x, action.y, action.button, context);
              break;
            case 'double_click':
              await driver.doubleClick(action.x, action.y, context);
              break;
            case 'scroll':
              await driver.scroll(
                action.x,
                action.y,
                action.scroll_x,
                action.scroll_y,
                context,
              );
              break;
            case 'type':
              await driver.type(action.text, context);
              break;
            case 'wait':
              await driver.wait(context);
              break;
            case 'move':
              await driver.move(action.x, action.y, context);
              break;
            case 'keypress':
              await driver.keypress(action.keys, context);
              break;
            case 'drag':
              await driver.drag(
                action.path.map(({ x, y }) => [x, y]),
                context,
              );
              break;
          }
          admit();
        }
        if (actions.at(-1)?.type !== 'screenshot') {
          screenshot = await driver.screenshot(context);
          admit();
        }
        if (typeof screenshot !== 'string' || !screenshot)
          throw new TypeError(
            'Computer screenshot must return base64 PNG data',
          );
        const output: JsonValue = {
          output: {
            type: 'computer_screenshot',
            image_url: `data:image/png;base64,${screenshot}`,
          },
          acknowledged_safety_checks: pending,
        };
        return {
          success: true,
          contentItems: [{ type: 'inputText', text: JSON.stringify(output) }],
        };
      } catch (error) {
        // Seal the existing callback owner before opening the device's queue.
        if (!context.signal.aborted)
          reportFailure(
            error instanceof Error
              ? error
              : new Error('Computer execution failed'),
          );
        throw error;
      } finally {
        releaseDevice?.();
        release();
      }
    },
  );
}
