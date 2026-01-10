import { describe, expect, it } from 'vitest';

import {
  buildAgentInputPool,
  getAgentInputItemKey,
  removeAgentInputFromPool,
  agentInputSerializationReplacer,
} from '../../src/runner/items';
import { AgentInputItem } from '../../src/types';

describe('runner/items pool helpers', () => {
  const baseItem: AgentInputItem = {
    type: 'message',
    role: 'user',
    content: 'hi',
  };

  it('keeps pool entries when removal is attempted with a different reference', () => {
    const pool = buildAgentInputPool([baseItem]);
    const key = getAgentInputItemKey(baseItem);

    removeAgentInputFromPool(pool, { ...baseItem });

    const remaining = pool.get(key);
    expect(remaining).toBeDefined();
    expect(remaining?.length).toBe(1);

    // Now remove the original reference and ensure the entry disappears.
    removeAgentInputFromPool(pool, baseItem);
    expect(pool.has(key)).toBe(false);
  });
});

describe('runner/items serialization', () => {
  it('encodes ArrayBuffer values', () => {
    const buffer = new Uint8Array([1, 2]).buffer;
    const replaced = agentInputSerializationReplacer('', buffer) as {
      __type: string;
      data: string;
    };

    expect(replaced).toEqual({
      __type: 'ArrayBuffer',
      data: 'AQI=',
    });
  });

  it('encodes typed array views', () => {
    const view = new Uint16Array([3]);
    const replaced = agentInputSerializationReplacer('', view) as {
      __type: string;
      data: string;
    };

    expect(replaced.__type).toBe('Uint16Array');
    expect(replaced.data).toBe('AwA=');
  });

  it('encodes Node Buffers and serialized Buffer snapshots', () => {
    const nodeBuffer = Buffer.from([4, 5]);
    const fromBuffer = agentInputSerializationReplacer('', nodeBuffer) as {
      __type: string;
      data: string;
    };
    expect(fromBuffer).toEqual({
      __type: 'Buffer',
      data: 'BAU=',
    });

    const snapshot = { type: 'Buffer', data: [6, 7] };
    const fromSnapshot = agentInputSerializationReplacer('', snapshot) as {
      __type: string;
      data: string;
    };
    expect(fromSnapshot).toEqual({
      __type: 'Buffer',
      data: 'Bgc=',
    });
  });
});
