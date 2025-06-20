import { setDefaultModelProvider } from '@chollier/agents-core';
import { OpenAIProvider } from '@chollier/agents-openai';
import { setDefaultOpenAITracingExporter } from '@chollier/agents-openai';

setDefaultModelProvider(new OpenAIProvider());
setDefaultOpenAITracingExporter();

export * from '@chollier/agents-core';
export * from '@chollier/agents-openai';
export * as realtime from '@chollier/agents-realtime';
