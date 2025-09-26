import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'dist/index.mjs'),
      name: 'OpenAIAgentsRealtime',
      // the proper extensions will be added
      fileName: 'openai-realtime-agents',
    },
    sourcemap: 'inline',
    rollupOptions: {
      // make sure to externalize deps that shouldn't be bundled
      // into your library
      external: [],
      output: {
        dir: 'dist/bundle',
        banner: '/** OpenAI Agents Realtime **/',
        minifyInternalExports: false,
        // Provide global variables to use in the UMD build
        // for externalized deps
        globals: {},
      },
    },
  },
  define: {
    // Define Node.js globals for browser compatibility
    global: 'globalThis',
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  resolve: {
    alias: {
      // Stub out Node.js modules that shouldn't be used in browser
      'node:stream': resolve(__dirname, 'src/stubs/empty.js'),
      'node:process': resolve(__dirname, 'src/stubs/process.js'),
      child_process: resolve(__dirname, 'src/stubs/empty.js'),
      fs: resolve(__dirname, 'src/stubs/empty.js'),
      path: resolve(__dirname, 'src/stubs/empty.js'),
      os: resolve(__dirname, 'src/stubs/empty.js'),
      crypto: resolve(__dirname, 'src/stubs/empty.js'),
      util: resolve(__dirname, 'src/stubs/empty.js'),
      events: resolve(__dirname, 'src/stubs/empty.js'),
      buffer: resolve(__dirname, 'src/stubs/empty.js'),
      stream: resolve(__dirname, 'src/stubs/empty.js'),
      url: resolve(__dirname, 'src/stubs/empty.js'),
      querystring: resolve(__dirname, 'src/stubs/empty.js'),
      http: resolve(__dirname, 'src/stubs/empty.js'),
      https: resolve(__dirname, 'src/stubs/empty.js'),
      net: resolve(__dirname, 'src/stubs/empty.js'),
      tls: resolve(__dirname, 'src/stubs/empty.js'),
      zlib: resolve(__dirname, 'src/stubs/empty.js'),
      process: resolve(__dirname, 'src/stubs/process.js'),
      // Stub out MCP SDK modules
      '@modelcontextprotocol/sdk/client/stdio.js': resolve(
        __dirname,
        'src/stubs/empty.js',
      ),
      '@modelcontextprotocol/sdk/client/sse.js': resolve(
        __dirname,
        'src/stubs/empty.js',
      ),
      '@modelcontextprotocol/sdk/client/streamableHttp.js': resolve(
        __dirname,
        'src/stubs/empty.js',
      ),
      '@modelcontextprotocol/sdk/client/index.js': resolve(
        __dirname,
        'src/stubs/empty.js',
      ),
      '@modelcontextprotocol/sdk/types.js': resolve(
        __dirname,
        'src/stubs/empty.js',
      ),
      '@modelcontextprotocol/sdk/shared/protocol.js': resolve(
        __dirname,
        'src/stubs/empty.js',
      ),
      'cross-spawn': resolve(__dirname, 'src/stubs/empty.js'),
    },
  },
});
