import {
  setOpenAIAPI,
  setOpenAIResponsesTransport,
} from '@openai/agents/classic';

setOpenAIAPI('responses');
setOpenAIResponsesTransport('websocket');
