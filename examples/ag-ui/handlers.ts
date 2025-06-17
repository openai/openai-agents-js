import { IncomingMessage, ServerResponse } from 'http';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { agui } from '@openai/agents-extensions';
import { mainAgent } from './agents';
import { ChatRequest } from './types';

export class RequestHandler {
  private static readonly CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  private static readonly SSE_HEADERS = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    ...RequestHandler.CORS_HEADERS,
  };

  static setCorsHeaders(res: ServerResponse): void {
    Object.entries(RequestHandler.CORS_HEADERS).forEach(([key, value]) => {
      res.setHeader(key, value);
    });
  }

  static async handleOptions(res: ServerResponse): Promise<void> {
    RequestHandler.setCorsHeaders(res);
    res.writeHead(200);
    res.end();
  }

  static async handleRoot(res: ServerResponse): Promise<void> {
    try {
      const htmlPath = join(__dirname, 'client.html');
      const html = await readFile(htmlPath, 'utf-8');

      RequestHandler.setCorsHeaders(res);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch (error) {
      console.error('Error serving client:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to load client' }));
    }
  }

  static async handleChat(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const body = await RequestHandler.parseRequestBody(req);
      const { message } = RequestHandler.validateChatRequest(body);

      res.writeHead(200, RequestHandler.SSE_HEADERS);

      const result = await agui.runWithAGUI(mainAgent, message, {
        stream: true,
        agui: {
          thread_id: RequestHandler.generateId('thread'),
          run_id: RequestHandler.generateId('run'),
          includeRawEvents: true,
          includeStateSnapshots: true,
        },
      });

      // Stream AG-UI events as SSE
      for await (const event of result.toAGUIAsyncIterator()) {
        const data = JSON.stringify(event);
        res.write(`data: ${data}\n\n`);
      }

      // Wait for completion and close
      await result.completed;
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (error) {
      console.error('Chat error:', error);

      const errorEvent = {
        type: 'RUN_ERROR',
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: Date.now(),
      };

      if (!res.headersSent) {
        res.writeHead(200, RequestHandler.SSE_HEADERS);
      }

      res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }

  static async handle404(res: ServerResponse): Promise<void> {
    RequestHandler.setCorsHeaders(res);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private static async parseRequestBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let body = '';

      req.on('data', (chunk) => {
        body += chunk.toString();
      });

      req.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (_error) {
          reject(new Error('Invalid JSON in request body'));
        }
      });

      req.on('error', (error) => {
        reject(error);
      });
    });
  }

  private static validateChatRequest(body: any): ChatRequest {
    if (!body || typeof body !== 'object') {
      throw new Error('Request body must be an object');
    }

    if (!body.message || typeof body.message !== 'string') {
      throw new Error('Message is required and must be a string');
    }

    if (body.message.trim().length === 0) {
      throw new Error('Message cannot be empty');
    }

    return { message: body.message.trim() };
  }

  private static generateId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}
