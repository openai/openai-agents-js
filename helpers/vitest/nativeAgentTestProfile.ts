export const nativeAgentTestIncludes =
  process.env.OPENAI_AGENTS_NATIVE_TESTS === '1'
    ? ['test/**/*.test.ts']
    : [
        'test/*.test.ts',
        'test/native/{binding,history,tools,manual,state,local-storage-unit,native-goals-unit,testing,web-search,checklist,capabilities-unit,local-checklist,mcp-policy,history-counters,opening-cleanup,carrier-cleanup,onboarding,examples-native,parity-data,parity-agent,conversation-example,manual-replies,application-memory,validated-artifact}.test.ts',
        'test/native/timeout-cleanup-example.test.ts',
        'test/native/external-job.test.ts',
        'test/native/specialist-agent.test.ts',
        'test/native/observability-examples.test.ts',
        'test/native/memory-retrieval-examples.test.ts',
        'test/native/image-input-example.test.ts',
        'test/native/turn-events.test.ts',
        'test/native/child-observations.test.ts',
        'test/native/selected-mcp.test.ts',
        'test/experimental/**/*.test.ts',
        'test/classic/**/*.test.ts',
        'test/native/output-state.test.ts',
        'test/native/repair-observation.test.ts',
        'test/native/request-metadata.test.ts',
      ];
