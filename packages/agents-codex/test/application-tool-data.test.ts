import { expect, it } from 'vitest';
import { z } from 'zod';
import { manualTool, ToolOutput } from '../src';
import { prepareManualResult } from '../src/runtime/manual';
import {
  outputOf,
  toolApplicationData,
  withToolApplicationData,
} from '../src/runtime/tools';

it('detaches application data and excludes it from native responses', () => {
  const data = { privateValue: { count: 1 } };
  const output = new ToolOutput(
    [{ type: 'inputText', text: 'public' }],
    true,
    data,
  );
  data.privateValue.count = 99;
  expect(output.applicationData).toEqual({ privateValue: { count: 1 } });
  const response = outputOf(output);
  expect(JSON.parse(JSON.stringify(response))).toEqual({
    success: true,
    contentItems: [{ type: 'inputText', text: 'public' }],
  });
  expect(structuredClone(response)).not.toHaveProperty('applicationData');
  const first = toolApplicationData(response)!;
  first.privateValue = 'changed';
  expect(toolApplicationData(response)).toEqual({ privateValue: { count: 1 } });
});

it('keeps omitted, null and empty application data absent', () => {
  for (const data of [undefined, null, {}]) {
    const output = new ToolOutput([], true, data);
    expect(output).not.toHaveProperty('applicationData');
    expect(toolApplicationData(outputOf(output))).toBeUndefined();
    expect(
      toolApplicationData(withToolApplicationData({}, data)),
    ).toBeUndefined();
  }
});

it('rejects non-JSON application values before result publication', () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const data of [
    { value: NaN },
    { value: undefined },
    { value: new Date() },
    cycle,
    [],
  ])
    expect(() => new ToolOutput([], true, data as never)).toThrow();
});

it('preserves a validated manual ToolOutput without serializing its private data', () => {
  const declaration = manualTool({
    name: 'record',
    description: 'Record a public result',
    parameters: z.object({}),
    result: z.string().transform(
      (text) =>
        new ToolOutput([{ type: 'inputText', text }], true, {
          ticket: 'private-manual',
        }),
    ),
  });
  expect(() => prepareManualResult(declaration, 'public manual')).not.toThrow();
  expect(() => prepareManualResult(declaration, 17)).toThrow('validation');
});
