import { describe, it, expect } from 'vitest';
import { fileSearchTool, webSearchTool } from '../src/tools';

describe('Tool', () => {
  it('webSearchTool', () => {
    const t = webSearchTool({
      userLocation: { type: 'approximate', city: 'Tokyo' },
    });
    expect(t).toBeDefined();
    expect(t.type).toBe('hosted_tool');
    expect(t.name).toBe('web_search');
  });

  it('fileSearchTool', () => {
    const t = fileSearchTool(['test'], {});
    expect(t).toBeDefined();
    expect(t.type).toBe('hosted_tool');
    expect(t.name).toBe('file_search');

    const t2 = fileSearchTool('test', {});
    expect(t2).toBeDefined();
    expect(t2.type).toBe('hosted_tool');
    expect(t2.name).toBe('file_search');
  });
});
