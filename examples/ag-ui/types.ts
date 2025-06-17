export interface ChatRequest {
  message: string;
}

export interface ChatResponse {
  error?: string;
}

export interface AGUIServerConfig {
  port: number;
  corsOrigin: string;
}
