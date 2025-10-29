import type { AgentInputItem } from '../types';

/**
 * A function that combines session history with new input items before the model call.
 */
export type SessionInputCallback = (
  historyItems: AgentInputItem[],
  newItems: AgentInputItem[],
) => AgentInputItem[] | Promise<AgentInputItem[]>;

/**
 * Interface representing a persistent session store for conversation history.
 */
export interface Session {
  /**
   * Ensure and return the identifier for this session.
   */
  getSessionId(): Promise<string>;

  /**
   * Retrieve items from the conversation history.
   *
   * @param limit - The maximum number of items to return. When provided the most
   * recent {@link limit} items should be returned in chronological order.
   */
  getItems(limit?: number): Promise<AgentInputItem[]>;

  /**
   * Append new items to the conversation history.
   *
   * @param items - Items to add to the session history.
   */
  addItems(items: AgentInputItem[]): Promise<void>;

  /**
   * Remove and return the most recent item from the conversation history if it
   * exists.
   */
  popItem(): Promise<AgentInputItem | undefined>;

  /**
   * Remove all items that belong to the session and reset its state.
   */
  clearSession(): Promise<void>;
}
