import { setOpenAIAPI, setOpenAIResponsesTransport } from '@openai/agents';

setOpenAIAPI('responses');
setOpenAIResponsesTransport('websocket');
