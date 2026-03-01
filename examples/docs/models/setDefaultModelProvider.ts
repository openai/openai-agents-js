import { setDefaultModelProvider } from '@openai/agents';

setDefaultModelProvider({
  async getModel() {
    // Return any Model implementation here.
    throw new Error('Provide your own model implementation.');
  },
});
