import assert from 'node:assert/strict';
import { Agent, computerTool, type Computer } from '@openai/agents';
import {
  computerCall,
  text,
  withScriptedResponses,
} from '@openai/agents/testing';

// A 1 × 1 PNG for the fake screenshot.
const pixel =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==';
let screenshots = 0;
const unexpected = () => {
  throw new Error('Unexpected computer action');
};
const driver: Computer = {
  screenshot: () => {
    screenshots++;
    return pixel;
  },
  click: unexpected,
  doubleClick: unexpected,
  scroll: unexpected,
  type: unexpected,
  wait: unexpected,
  move: unexpected,
  keypress: unexpected,
  drag: unexpected,
};

await withScriptedResponses(
  [
    [computerCall([{ type: 'screenshot' }], { callId: 'screen-1' })],
    [text('Done.')],
  ],
  async (peer) => {
    const agent = new Agent({
      instructions: 'Take a screenshot.',
      provider: peer.provider,
      tools: [computerTool({ computer: driver })],
    });
    assert.equal((await agent.run('Look at the screen.')).finalOutput, 'Done.');
    assert.equal(screenshots, 1);

    const input = peer.requests[1]?.input;
    assert.ok(Array.isArray(input));
    const receipt = input.find(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        'type' in item &&
        item.type === 'computer_call_output',
    );
    assert.ok(
      receipt && typeof receipt === 'object' && !Array.isArray(receipt),
    );
    assert.equal(receipt.call_id, 'screen-1');
    assert.deepEqual(receipt.output, {
      type: 'computer_screenshot',
      image_url: `data:image/png;base64,${pixel}`,
    });
  },
);
