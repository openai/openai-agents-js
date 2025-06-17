import { createServer, IncomingMessage, ServerResponse } from 'http';
import { RequestHandler } from './handlers';
import { AGUIServerConfig } from './types';

class AGUIServer {
  private config: AGUIServerConfig;

  constructor(config: Partial<AGUIServerConfig> = {}) {
    this.config = {
      port: config.port ?? 3001,
      corsOrigin: config.corsOrigin ?? '*',
    };
  }

  async start(): Promise<void> {
    const server = createServer(this.handleRequest.bind(this));

    server.listen(this.config.port, () => {
      console.log(
        `🚀 AG-UI Server running at http://localhost:${this.config.port}`,
      );
      console.log('');
      console.log('Available endpoints:');
      console.log(`  • GET  / - Interactive client`);
      console.log(`  • POST /chat - Send messages`);
      console.log('');
      console.log(
        'The server streams AG-UI compatible events for real-time agent interactions.',
      );
    });

    // Graceful shutdown
    process.on('SIGINT', () => {
      console.log('\n🛑 Shutting down server...');
      server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
      });
    });
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const { method, url } = req;

    try {
      if (method === 'OPTIONS') {
        await RequestHandler.handleOptions(res);
        return;
      }

      switch (url) {
        case '/':
          if (method === 'GET') {
            await RequestHandler.handleRoot(res);
          } else {
            await RequestHandler.handle404(res);
          }
          break;

        case '/chat':
          if (method === 'POST') {
            await RequestHandler.handleChat(req, res);
          } else {
            await RequestHandler.handle404(res);
          }
          break;

        default:
          await RequestHandler.handle404(res);
          break;
      }
    } catch (error) {
      console.error('Server error:', error);

      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'Internal server error',
            message: error instanceof Error ? error.message : 'Unknown error',
          }),
        );
      }
    }
  }
}

// Start server if this file is run directly
if (require.main === module) {
  const server = new AGUIServer();
  server.start().catch(console.error);
}

export { AGUIServer };
