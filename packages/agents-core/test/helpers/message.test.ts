import { describe, it, expect } from 'vitest';
import { user, system, assistant } from '../../src/helpers/message';
import { UserContent } from '../../src/types';

describe('message helpers', () => {
  it('user() converts string to message', () => {
    const msg = user('hi');
    expect(msg).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hi' }],
      providerData: undefined,
    });
  });

  it('user() keeps array content and provider data', () => {
    const content: UserContent[] = [
      { type: 'input_text', text: 'a', providerData: { foo: 'b' } },
    ];
    const msg = user(content, { extra: true });
    expect(msg.content).toBe(content);
    expect(msg.providerData).toEqual({ extra: true });
  });

  it('system() returns system message', () => {
    const msg = system('rules', { id: 1 });
    expect(msg).toEqual({
      type: 'message',
      role: 'system',
      content: 'rules',
      providerData: { id: 1 },
    });
  });

  it('assistant() converts text to assistant message', () => {
    const msg = assistant('output');
    expect(msg.role).toBe('assistant');
    expect(msg.status).toBe('completed');
    expect(msg.content).toEqual([{ type: 'output_text', text: 'output' }]);
  });
});
