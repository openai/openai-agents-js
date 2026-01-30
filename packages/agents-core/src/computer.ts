export type Environment = 'mac' | 'windows' | 'ubuntu' | 'browser';
export type Button = 'left' | 'right' | 'wheel' | 'back' | 'forward';

import type { RunContext } from './runContext';
import { Expand, SnakeToCamelCase } from './types/helpers';
import type { ComputerAction } from './types/protocol';

type Promisable<T> = T | Promise<T>;

/**
 * Interface to implement for a computer environment to be used by the agent.
 */
interface ComputerBase {
  environment: Environment;
  dimensions: [number, number];

  initRun?(runContext?: RunContext): Promisable<void>;

  screenshot(runContext?: RunContext): Promisable<string>;
  click(
    x: number,
    y: number,
    button: Button,
    runContext?: RunContext,
  ): Promisable<void>;
  doubleClick(x: number, y: number, runContext?: RunContext): Promisable<void>;
  scroll(
    x: number,
    y: number,
    scrollX: number,
    scrollY: number,
    runContext?: RunContext,
  ): Promisable<void>;
  type(text: string, runContext?: RunContext): Promisable<void>;
  wait(runContext?: RunContext): Promisable<void>;
  move(x: number, y: number, runContext?: RunContext): Promisable<void>;
  keypress(keys: string[], runContext?: RunContext): Promisable<void>;
  drag(path: [number, number][], runContext?: RunContext): Promisable<void>;
}

// This turns every snake_case string in the ComputerAction['type'] into a camelCase string
type ActionNames = SnakeToCamelCase<ComputerAction['type']>;

/**
 * Interface representing a fully implemented computer environment.
 * Combines the base operations with a constraint that no extra
 * action names beyond those in `ComputerAction` are present.
 */
export type Computer = Expand<
  ComputerBase & Record<Exclude<ActionNames, keyof ComputerBase>, never>
>;
