import { Agent } from '@openai/agents/classic';

interface Purchase {
  id: string;
  uid: string;
  deliveryStatus: string;
}
interface UserContext {
  uid: string;
  isProUser: boolean;

  // this function can be used within tools
  fetchPurchases(): Promise<Purchase[]>;
}

const agent = new Agent<UserContext>({
  name: 'Personal shopper',
  instructions: 'Recommend products the user will love.',
});

// Later
import { run } from '@openai/agents/classic';

const result = await run(agent, 'Find me a new pair of running shoes', {
  context: { uid: 'abc', isProUser: true, fetchPurchases: async () => [] },
});
