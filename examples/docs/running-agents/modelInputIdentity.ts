import { CallModelInputFilter, Runner } from '@openai/agents';

const inspectedItems = new WeakSet<object>();

const inspectInputOnce: CallModelInputFilter = ({ modelData }) => {
  for (const item of modelData.input) {
    if (item && typeof item === 'object' && !inspectedItems.has(item)) {
      inspectedItems.add(item);
      recordPreparedItem(item);
    }
  }

  return modelData;
};

// Keep SDK-prepared item identities stable across repeated model calls so the
// WeakSet can recognize items that this filter already inspected. Do not mutate
// the items or their nested values.
inspectInputOnce.preserveInputIdentity = true;

const runner = new Runner({ callModelInputFilter: inspectInputOnce });

declare function recordPreparedItem(item: object): void;

export { runner };
