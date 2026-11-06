export type AgentState = 'idle' | 'listening' | 'thinking' | 'speaking';

export type PublicEvent =
  | { type: 'app.session.ready' }
  | { type: 'app.agent.state'; state: AgentState }
  | {
      type: 'app.error';
      code:
        | 'VOICE_RESPONSE_ERROR'
        | 'VOICE_SESSION_DISCONNECTED'
        | 'VOICE_SESSION_ERROR';
    }
  | { type: 'app.session.closed' };
