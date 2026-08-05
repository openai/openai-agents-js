import {
  Agent,
  run,
  type AgentInputItem,
  type RunContext,
  type RunContextAwareSession,
} from '@openai/agents';

type TenantContext = {
  tenantId: string;
};

class TenantSession implements RunContextAwareSession<TenantContext> {
  readonly acceptsRunContext = true;
  private readonly itemsByTenant = new Map<string, AgentInputItem[]>();

  async getSessionId(): Promise<string> {
    return 'shared-tenant-session';
  }

  async getItems(
    limit?: number,
    runContext?: RunContext<TenantContext>,
  ): Promise<AgentInputItem[]> {
    const items = this.getTenantItems(runContext);
    return limit === undefined ? [...items] : items.slice(-limit);
  }

  async addItems(
    items: AgentInputItem[],
    runContext?: RunContext<TenantContext>,
  ): Promise<void> {
    this.getTenantItems(runContext).push(...items);
  }

  async popItem(
    runContext?: RunContext<TenantContext>,
  ): Promise<AgentInputItem | undefined> {
    return this.getTenantItems(runContext).pop();
  }

  async clearSession(runContext?: RunContext<TenantContext>): Promise<void> {
    this.itemsByTenant.set(this.getTenantId(runContext), []);
  }

  private getTenantItems(
    runContext: RunContext<TenantContext> | undefined,
  ): AgentInputItem[] {
    const tenantId = this.getTenantId(runContext);
    const items = this.itemsByTenant.get(tenantId) ?? [];
    this.itemsByTenant.set(tenantId, items);
    return items;
  }

  private getTenantId(
    runContext: RunContext<TenantContext> | undefined,
  ): string {
    if (!runContext) {
      throw new Error('TenantSession requires a run context.');
    }
    return runContext.context.tenantId;
  }
}

const agent = new Agent<TenantContext>({
  name: 'Assistant',
  instructions: 'Reply concisely.',
});
const session = new TenantSession();

await run(agent, 'Remember that my favorite color is green.', {
  context: { tenantId: 'tenant-a' },
  session,
});

await run(agent, 'What is my favorite color?', {
  context: { tenantId: 'tenant-a' },
  session,
});
