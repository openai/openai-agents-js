import type { z } from 'zod';
import type { SerializedRunState } from './runState';
import { UserError } from './errors';
import { getToolCallNamespace } from './toolIdentity';
import * as protocol from './types/protocol';

type SerializedState = z.infer<typeof SerializedRunState>;
type SerializedAgentReference = SerializedState['currentAgent'];

function getCompactionSourceResponses(
  stateJson: SerializedState,
): SerializedState['modelResponses'][number][] {
  return stateJson.modelResponses.length > 0
    ? stateJson.modelResponses
    : stateJson.lastModelResponse
      ? [stateJson.lastModelResponse]
      : [];
}

function findLatestCompactionSource(stateJson: SerializedState):
  | {
      sourceResponses: SerializedState['modelResponses'][number][];
      responseIndex: number;
      itemIndex: number;
      item: protocol.CompactionItem;
    }
  | undefined {
  const sourceResponses = getCompactionSourceResponses(stateJson);
  for (
    let responseIndex = sourceResponses.length - 1;
    responseIndex >= 0;
    responseIndex -= 1
  ) {
    const output = sourceResponses[responseIndex].output;
    for (let itemIndex = output.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = output[itemIndex];
      if (item.type === 'compaction') {
        return { sourceResponses, responseIndex, itemIndex, item };
      }
    }
  }
  return undefined;
}

/**
 * Older writers kept raw compaction output but dropped its RunItem wrapper. Restore the latest
 * marker before resuming because it carries the context required for the next model window.
 */
type LegacyCompactionRehydration = {
  stateJson: SerializedState;
  sessionReconciliation?: {
    generatedInsertionIndex: number;
    previousPersistedItemCount: number;
  };
};

export function rehydrateLegacyCompactionRunItems(
  stateJson: SerializedState,
): LegacyCompactionRehydration {
  const latestCompaction = findLatestCompactionSource(stateJson);
  if (!latestCompaction) {
    return { stateJson };
  }

  const {
    sourceResponses,
    responseIndex: sourceResponseIndex,
    itemIndex: compactionIndex,
    item: compactionItem,
  } = latestCompaction;
  const sourceResponse = sourceResponses[sourceResponseIndex];
  const isLatestSourceResponse =
    sourceResponseIndex === sourceResponses.length - 1;
  const processedItems = isLatestSourceResponse
    ? stateJson.lastProcessedResponse?.newItems
    : undefined;
  const optionalLatestFunctionCallIndices =
    getOmittedLegacyHandoffFunctionCallIndices(
      sourceResponses.at(-1)?.output ?? [],
      stateJson.lastProcessedResponse,
    );
  const processedInsertion = processedItems
    ? findLegacyCompactionInsertionIndex(
        processedItems,
        sourceResponse.output,
        compactionIndex,
        optionalLatestFunctionCallIndices,
      )
    : undefined;
  let generatedInsertionAgent: SerializedAgentReference | undefined;
  let generatedInsertionIndex: number;
  if (!isLatestSourceResponse) {
    const followingResponseBoundary = stateJson.lastProcessedResponse
      ? findFollowingLegacyResponsesBoundary(
          stateJson.generatedItems,
          stateJson.lastProcessedResponse.newItems,
          sourceResponses
            .slice(sourceResponseIndex + 1)
            .map((response) => response.output),
          optionalLatestFunctionCallIndices,
        )
      : undefined;
    if (!followingResponseBoundary) {
      throwLegacyCompactionOrderingError();
    }
    const historicalInsertion = findHistoricalLegacyCompactionInsertion(
      stateJson.generatedItems.slice(0, followingResponseBoundary.itemIndex),
      sourceResponse.output,
      compactionIndex,
      followingResponseBoundary,
      sourceResponseIndex > 0,
    );
    generatedInsertionIndex = historicalInsertion.itemIndex;
    generatedInsertionAgent = historicalInsertion.agent;
  } else if (processedItems !== undefined) {
    const segmentStart = findTrailingProcessedSegmentStart(
      stateJson.generatedItems,
      processedItems,
    );
    if (segmentStart === undefined) {
      throwLegacyCompactionOrderingError();
    }
    const generatedInsertion = findLegacyCompactionInsertionIndex(
      stateJson.generatedItems.slice(segmentStart),
      sourceResponse.output,
      compactionIndex,
      optionalLatestFunctionCallIndices,
    );
    generatedInsertionIndex = segmentStart + generatedInsertion.itemIndex;
    generatedInsertionAgent = generatedInsertion.agent;
  } else {
    const generatedInsertion = findLegacyCompactionInsertionIndex(
      stateJson.generatedItems,
      sourceResponse.output,
      compactionIndex,
    );
    generatedInsertionIndex = generatedInsertion.itemIndex;
    generatedInsertionAgent = generatedInsertion.agent;
  }

  const serializedCompactionAgent =
    processedInsertion?.agent ??
    generatedInsertionAgent ??
    stateJson.currentAgent;
  if (
    processedInsertion?.agent &&
    generatedInsertionAgent &&
    getCanonicalLegacyCompactionKey(processedInsertion.agent) !==
      getCanonicalLegacyCompactionKey(generatedInsertionAgent)
  ) {
    throwLegacyCompactionOrderingError();
  }

  const serializedCompactionItem = {
    type: 'compaction_item' as const,
    rawItem: compactionItem,
    agent: serializedCompactionAgent,
  };

  const previousPersistedItemCount =
    stateJson.currentTurnPersistedItemCount ?? 0;
  return {
    stateJson: {
      ...stateJson,
      generatedItems: [
        ...stateJson.generatedItems.slice(0, generatedInsertionIndex),
        serializedCompactionItem,
        ...stateJson.generatedItems.slice(generatedInsertionIndex),
      ],
      ...(processedItems
        ? {
            lastProcessedResponse: {
              ...stateJson.lastProcessedResponse!,
              newItems: [
                ...processedItems.slice(0, processedInsertion!.itemIndex),
                serializedCompactionItem,
                ...processedItems.slice(processedInsertion!.itemIndex),
              ],
            },
          }
        : {}),
    },
    ...(generatedInsertionIndex < previousPersistedItemCount
      ? {
          sessionReconciliation: {
            generatedInsertionIndex,
            previousPersistedItemCount,
          },
        }
      : {}),
  };
}

function findHistoricalLegacyCompactionInsertion(
  items: SerializedState['generatedItems'][number][],
  sourceOutput: protocol.OutputModelItem[],
  compactionIndex: number,
  followingResponseBoundary: {
    itemIndex: number;
    agent: SerializedAgentReference;
  },
  allowEarlierResponseAnchors: boolean,
): { itemIndex: number; agent: SerializedAgentReference } {
  const providerAnchors = getLegacyProviderOutputAnchors(items, sourceOutput);
  const representedSourceItems = getRepresentedLegacySourceItems(
    sourceOutput,
    compactionIndex,
    providerAnchors,
  );
  const requiredSourceItems = getRequiredLegacySourceItems(
    sourceOutput,
    compactionIndex,
  );
  assertRequiredLegacySourceItemsRepresented(
    requiredSourceItems,
    representedSourceItems,
  );
  if (representedSourceItems.length === 0) {
    if (!allowEarlierResponseAnchors && providerAnchors.length > 0) {
      throwLegacyCompactionOrderingError();
    }
    return followingResponseBoundary;
  }

  const matchingStarts: number[] = [];
  for (
    let start = 0;
    start <= providerAnchors.length - representedSourceItems.length;
    start += 1
  ) {
    if (
      representedSourceItems.every(
        (sourceItem, offset) =>
          providerAnchors[start + offset]?.key === sourceItem.key,
      )
    ) {
      matchingStarts.push(start);
    }
  }
  if (matchingStarts.length !== 1) {
    throwLegacyCompactionOrderingError();
  }

  const matchedAnchors = providerAnchors.slice(
    matchingStarts[0],
    matchingStarts[0] + representedSourceItems.length,
  );
  const agent = matchedAnchors[0].agent;
  const agentKey = getCanonicalLegacyCompactionKey(agent);
  if (
    matchedAnchors.some(
      (anchor) => getCanonicalLegacyCompactionKey(anchor.agent) !== agentKey,
    )
  ) {
    throwLegacyCompactionOrderingError();
  }

  const followingSourceIndex = representedSourceItems.findIndex(
    (item) => item.sourceIndex > compactionIndex,
  );
  if (followingSourceIndex >= 0) {
    return {
      itemIndex: matchedAnchors[followingSourceIndex].itemIndex,
      agent,
    };
  }

  const previousAnchor = matchedAnchors[matchedAnchors.length - 1];
  let itemIndex = previousAnchor.itemIndex + 1;
  while (
    items[itemIndex]?.type === 'tool_approval_item' &&
    getCanonicalLegacyCompactionKey(items[itemIndex].rawItem) ===
      previousAnchor.key
  ) {
    itemIndex += 1;
  }
  return { itemIndex, agent };
}

function findFollowingLegacyResponseBoundary(
  generatedItems: SerializedState['generatedItems'][number][],
  processedItems: SerializedState['generatedItems'][number][],
  sourceOutput: protocol.OutputModelItem[],
  optionalFunctionCallIndices: ReadonlySet<number> = new Set(),
): { itemIndex: number; agent: SerializedAgentReference } | undefined {
  const itemIndex = findTrailingProcessedSegmentStart(
    generatedItems,
    processedItems,
  );
  if (itemIndex === undefined) {
    throwLegacyCompactionOrderingError();
  }
  if (
    getLegacyProviderOutputAnchors(
      generatedItems.slice(itemIndex + processedItems.length),
      sourceOutput,
    ).length > 0
  ) {
    throwLegacyCompactionOrderingError();
  }

  const providerAnchors = getLegacyProviderOutputAnchors(
    processedItems,
    sourceOutput,
  );
  const representedSourceItems = getRepresentedLegacySourceItems(
    sourceOutput,
    -1,
    providerAnchors,
    optionalFunctionCallIndices,
  );
  assertRequiredLegacySourceItemsRepresented(
    getRequiredLegacySourceItems(sourceOutput, -1, optionalFunctionCallIndices),
    representedSourceItems,
  );
  if (
    providerAnchors.length === 0 ||
    providerAnchors.length !== representedSourceItems.length ||
    providerAnchors.some(
      (anchor, index) => anchor.key !== representedSourceItems[index]?.key,
    )
  ) {
    return undefined;
  }

  const agent = providerAnchors[0].agent;
  const agentKey = getCanonicalLegacyCompactionKey(agent);
  if (
    providerAnchors.some(
      (anchor) => getCanonicalLegacyCompactionKey(anchor.agent) !== agentKey,
    )
  ) {
    throwLegacyCompactionOrderingError();
  }
  return { itemIndex, agent };
}

function findFollowingLegacyResponsesBoundary(
  generatedItems: SerializedState['generatedItems'][number][],
  processedItems: SerializedState['generatedItems'][number][],
  sourceOutputs: protocol.OutputModelItem[][],
  optionalLatestFunctionCallIndices: ReadonlySet<number>,
): { itemIndex: number; agent: SerializedAgentReference } | undefined {
  const latestSourceOutput = sourceOutputs.at(-1);
  if (!latestSourceOutput) {
    return undefined;
  }

  let boundary = findFollowingLegacyResponseBoundary(
    generatedItems,
    processedItems,
    latestSourceOutput,
    optionalLatestFunctionCallIndices,
  );
  if (!boundary) {
    return undefined;
  }

  for (let index = sourceOutputs.length - 2; index >= 0; index -= 1) {
    boundary = findPrecedingLegacyResponseBoundary(
      generatedItems,
      boundary.itemIndex,
      sourceOutputs[index],
    );
  }
  return boundary;
}

function findPrecedingLegacyResponseBoundary(
  generatedItems: SerializedState['generatedItems'][number][],
  followingBoundaryIndex: number,
  sourceOutput: protocol.OutputModelItem[],
): { itemIndex: number; agent: SerializedAgentReference } {
  const precedingItems = generatedItems.slice(0, followingBoundaryIndex);
  const providerAnchors = getLegacyProviderOutputAnchors(
    precedingItems,
    sourceOutput,
  );
  const representedSourceItems = getRepresentedLegacySourceItems(
    sourceOutput,
    -1,
    providerAnchors,
  );
  assertRequiredLegacySourceItemsRepresented(
    getRequiredLegacySourceItems(sourceOutput, -1),
    representedSourceItems,
  );
  if (representedSourceItems.length === 0) {
    throwLegacyCompactionOrderingError();
  }

  const matchingStarts: number[] = [];
  for (
    let start = 0;
    start <= providerAnchors.length - representedSourceItems.length;
    start += 1
  ) {
    if (
      representedSourceItems.every(
        (sourceItem, offset) =>
          providerAnchors[start + offset]?.key === sourceItem.key,
      )
    ) {
      matchingStarts.push(start);
    }
  }
  if (matchingStarts.length !== 1) {
    throwLegacyCompactionOrderingError();
  }

  const matchingStart = matchingStarts[0];
  const matchedAnchors = providerAnchors.slice(
    matchingStart,
    matchingStart + representedSourceItems.length,
  );
  const trailingAnchors = providerAnchors.slice(
    matchingStart + representedSourceItems.length,
  );
  if (
    trailingAnchors.some(
      (anchor) =>
        precedingItems[anchor.itemIndex]?.type !== 'tool_call_output_item',
    )
  ) {
    throwLegacyCompactionOrderingError();
  }

  const agent = matchedAnchors[0].agent;
  const agentKey = getCanonicalLegacyCompactionKey(agent);
  if (
    matchedAnchors.some(
      (anchor) => getCanonicalLegacyCompactionKey(anchor.agent) !== agentKey,
    )
  ) {
    throwLegacyCompactionOrderingError();
  }
  return { itemIndex: matchedAnchors[0].itemIndex, agent };
}

function isLegacyProviderOutputRunItem(
  item: SerializedState['generatedItems'][number],
): item is SerializedState['generatedItems'][number] & {
  agent: SerializedAgentReference;
} {
  return (
    item.type === 'message_output_item' ||
    item.type === 'tool_search_call_item' ||
    item.type === 'tool_search_output_item' ||
    item.type === 'tool_call_item' ||
    (item.type === 'tool_call_output_item' &&
      (item.rawItem.type === 'program_output' ||
        item.rawItem.type === 'shell_call_output')) ||
    item.type === 'reasoning_item' ||
    item.type === 'handoff_call_item'
  );
}

function getLegacyProviderOutputAnchors(
  items: SerializedState['generatedItems'][number][],
  sourceOutput: protocol.OutputModelItem[],
): Array<{
  key: string;
  itemIndex: number;
  agent: SerializedAgentReference;
}> {
  const sourceOutputKeys = new Set(
    sourceOutput.map((item) => getLegacyProviderOutputKey(item)),
  );
  return items.flatMap((item, itemIndex) => {
    if (!isLegacyProviderOutputRunItem(item)) {
      return [];
    }
    const key = getLegacyProviderOutputKey(item.rawItem);
    if (
      (item.type === 'tool_search_output_item' ||
        (item.type === 'tool_call_output_item' &&
          (item.rawItem.type === 'program_output' ||
            item.rawItem.type === 'shell_call_output'))) &&
      !sourceOutputKeys.has(key)
    ) {
      return [];
    }
    return [{ key, itemIndex, agent: item.agent }];
  });
}

function getRepresentedLegacySourceItems(
  sourceOutput: protocol.OutputModelItem[],
  compactionIndex: number,
  providerAnchors: Array<{ key: string }>,
  optionalFunctionCallIndices: ReadonlySet<number> = new Set(),
): Array<{ key: string; sourceIndex: number }> {
  if (optionalFunctionCallIndices.size > 0) {
    let providerAnchorIndex = 0;
    return sourceOutput.flatMap((item, sourceIndex) => {
      if (
        sourceIndex === compactionIndex ||
        optionalFunctionCallIndices.has(sourceIndex)
      ) {
        return [];
      }
      const key = getLegacyProviderOutputKey(item);
      if (providerAnchors[providerAnchorIndex]?.key !== key) {
        return [];
      }
      providerAnchorIndex += 1;
      return [{ key, sourceIndex }];
    });
  }

  const providerKeys = new Set(providerAnchors.map((anchor) => anchor.key));
  return sourceOutput.flatMap((item, sourceIndex) => {
    if (sourceIndex === compactionIndex) {
      return [];
    }
    const key = getLegacyProviderOutputKey(item);
    return providerKeys.has(key) ? [{ key, sourceIndex }] : [];
  });
}

function getRequiredLegacySourceItems(
  sourceOutput: protocol.OutputModelItem[],
  compactionIndex: number,
  optionalFunctionCallIndices: ReadonlySet<number> = new Set(),
): Array<{ key: string; sourceIndex: number }> {
  return sourceOutput.flatMap((item, sourceIndex) => {
    const isOmittedHandoff =
      item.type === 'function_call' &&
      optionalFunctionCallIndices.has(sourceIndex);
    if (
      sourceIndex === compactionIndex ||
      item.type === 'compaction' ||
      isOmittedHandoff ||
      item.type === 'function_call_result' ||
      item.type === 'apply_patch_call_output' ||
      item.type === 'unknown'
    ) {
      return [];
    }
    return [{ key: getLegacyProviderOutputKey(item), sourceIndex }];
  });
}

function getOmittedLegacyHandoffFunctionCallIndices(
  sourceOutput: protocol.OutputModelItem[],
  processedResponse: SerializedState['lastProcessedResponse'] | undefined,
): ReadonlySet<number> {
  const matchedIndices: number[] = [];
  let sourceStartIndex = 0;
  for (const serializedHandoff of processedResponse?.handoffs ?? []) {
    const parsedToolCall = protocol.FunctionCallItem.safeParse(
      serializedHandoff.toolCall,
    );
    if (!parsedToolCall.success) {
      return new Set();
    }
    const key = getLegacyProviderOutputKey(parsedToolCall.data);
    const sourceIndex = sourceOutput.findIndex(
      (item, index) =>
        index >= sourceStartIndex &&
        item.type === 'function_call' &&
        getLegacyProviderOutputKey(item) === key,
    );
    if (sourceIndex < 0) {
      return new Set();
    }
    matchedIndices.push(sourceIndex);
    sourceStartIndex = sourceIndex + 1;
  }
  return new Set(matchedIndices.slice(1));
}

function assertRequiredLegacySourceItemsRepresented(
  requiredItems: Array<{ key: string; sourceIndex: number }>,
  representedItems: Array<{ key: string; sourceIndex: number }>,
): void {
  if (!isLegacySourceSubsequenceRepresented(requiredItems, representedItems)) {
    throwLegacyCompactionOrderingError();
  }
}

function isLegacySourceSubsequenceRepresented(
  requiredItems: Array<{ key: string; sourceIndex: number }>,
  representedItems: Array<{ key: string; sourceIndex: number }>,
): boolean {
  let representedIndex = 0;
  for (const requiredItem of requiredItems) {
    while (
      representedIndex < representedItems.length &&
      representedItems[representedIndex].sourceIndex < requiredItem.sourceIndex
    ) {
      representedIndex += 1;
    }
    if (
      representedItems[representedIndex]?.sourceIndex !==
        requiredItem.sourceIndex ||
      representedItems[representedIndex]?.key !== requiredItem.key
    ) {
      return false;
    }
    representedIndex += 1;
  }
  return true;
}

function getLegacyProviderOutputKey(item: protocol.ModelItem): string {
  if (item.type !== 'function_call') {
    return getCanonicalLegacyCompactionKey(item);
  }

  const namespace = getToolCallNamespace(item);
  if (!namespace) {
    return getCanonicalLegacyCompactionKey(item);
  }

  const normalizedItem = { ...item, name: `${namespace}.${item.name}` };
  delete normalizedItem.namespace;
  return getCanonicalLegacyCompactionKey(normalizedItem);
}

function findLegacyCompactionInsertionIndex(
  items: SerializedState['generatedItems'][number][],
  sourceOutput: protocol.OutputModelItem[],
  compactionIndex: number,
  optionalFunctionCallIndices: ReadonlySet<number> = new Set(),
): { itemIndex: number; agent?: SerializedAgentReference } {
  const providerAnchors = getLegacyProviderOutputAnchors(items, sourceOutput);
  const representedSourceItems = getRepresentedLegacySourceItems(
    sourceOutput,
    compactionIndex,
    providerAnchors,
    optionalFunctionCallIndices,
  );
  assertRequiredLegacySourceItemsRepresented(
    getRequiredLegacySourceItems(
      sourceOutput,
      compactionIndex,
      optionalFunctionCallIndices,
    ),
    representedSourceItems,
  );

  if (
    providerAnchors.length !== representedSourceItems.length ||
    providerAnchors.some(
      (anchor, index) => anchor.key !== representedSourceItems[index]?.key,
    )
  ) {
    throwLegacyCompactionOrderingError();
  }

  if (representedSourceItems.length === 0) {
    if (items.length !== 0) {
      throwLegacyCompactionOrderingError();
    }
    return { itemIndex: 0 };
  }

  const agent = providerAnchors[0].agent;
  const agentKey = getCanonicalLegacyCompactionKey(agent);
  if (
    providerAnchors.some(
      (anchor) => getCanonicalLegacyCompactionKey(anchor.agent) !== agentKey,
    )
  ) {
    throwLegacyCompactionOrderingError();
  }

  const retainedBeforeCompaction = representedSourceItems.filter(
    (item) => item.sourceIndex < compactionIndex,
  ).length;
  const followingAnchor = providerAnchors[retainedBeforeCompaction];
  if (followingAnchor) {
    if (retainedBeforeCompaction === 0 && followingAnchor.itemIndex !== 0) {
      throwLegacyCompactionOrderingError();
    }
    return { itemIndex: followingAnchor.itemIndex, agent };
  }
  return { itemIndex: items.length, agent };
}

function findTrailingProcessedSegmentStart(
  generatedItems: SerializedState['generatedItems'][number][],
  processedItems: SerializedState['generatedItems'][number][],
): number | undefined {
  for (
    let start = generatedItems.length - processedItems.length;
    start >= 0;
    start -= 1
  ) {
    const matches = processedItems.every((processedItem, offset) => {
      const generatedItem = generatedItems[start + offset];
      return (
        getCanonicalLegacyCompactionKey(generatedItem) ===
        getCanonicalLegacyCompactionKey(processedItem)
      );
    });
    if (matches) {
      return start;
    }
  }
  return undefined;
}

function throwLegacyCompactionOrderingError(): never {
  throw new UserError(
    'Run state cannot safely restore a legacy compaction item because its provider order is ambiguous.',
  );
}

function getCanonicalLegacyCompactionKey(value: unknown): string {
  return JSON.stringify(sortLegacyCompactionValue(value));
}

function sortLegacyCompactionValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortLegacyCompactionValue);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortLegacyCompactionValue(record[key])]),
  );
}
