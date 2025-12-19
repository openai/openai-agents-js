import { describe, it, expect } from 'vitest';
import { fileSearchTool, webSearchTool, imageGenerationTool } from '../src/tools';

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

  it('imageGenerationTool with gpt-image-1', () => {
    const t = imageGenerationTool({ model: 'gpt-image-1' });
    expect(t).toBeDefined();
    expect(t.type).toBe('hosted_tool');
    expect(t.name).toBe('image_generation');
    expect(t.providerData!.type).toBe('image_generation');
    expect(t.providerData!.model).toBe('gpt-image-1');
  });

  it('imageGenerationTool with gpt-image-1-mini', () => {
    const t = imageGenerationTool({ model: 'gpt-image-1-mini' });
    expect(t).toBeDefined();
    expect(t.type).toBe('hosted_tool');
    expect(t.name).toBe('image_generation');
    expect(t.providerData!.type).toBe('image_generation');
    expect(t.providerData!.model).toBe('gpt-image-1-mini');
  });

  it('imageGenerationTool with gpt-image-1.5', () => {
    const t = imageGenerationTool({ model: 'gpt-image-1.5' });
    expect(t).toBeDefined();
    expect(t.type).toBe('hosted_tool');
    expect(t.name).toBe('image_generation');
    expect(t.providerData!.type).toBe('image_generation');
    expect(t.providerData!.model).toBe('gpt-image-1.5');
  });

  it('imageGenerationTool without model', () => {
    const t = imageGenerationTool();
    expect(t).toBeDefined();
    expect(t.type).toBe('hosted_tool');
    expect(t.name).toBe('image_generation');
    expect(t.providerData!.type).toBe('image_generation');
    expect(t.providerData!.model).toBeUndefined();
  });
});
