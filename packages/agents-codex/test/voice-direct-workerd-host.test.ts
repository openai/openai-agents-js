import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile, copyFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it.skipIf(
  !process.env.WORKERD_PATH || process.env.OPENAI_AGENTS_PORTABLE_TESTS !== '1',
)(
  'executes Rust-owned direct voice through actual workerd WebSocketPair effects',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'voice-direct-workerd-'));
    const require = createRequire(import.meta.url);
    const { build } = createRequire(require.resolve('tsx'))('esbuild');
    const bundle = await build({
      stdin: {
        contents: `
import module from 'control.wasm';
import {NativeVoiceControl} from ${JSON.stringify(resolve('packages/agents-codex/src/voice/portable.ts'))};
import {connectPortableVoiceWorker} from ${JSON.stringify(resolve('packages/agents-codex/src/voice/workerd.ts'))};
export default {async fetch() {
  const pair = new WebSocketPair();
  const provider = pair[1];
  provider.accept();
  const frames=[];
  let finish;
  const done=new Promise(resolve=>finish=resolve);
  provider.addEventListener('message', ({data})=>{
    const event=JSON.parse(data);
    frames.push(event);
    if(event.type==='session.update') {
      provider.send(JSON.stringify({type:'session.updated',session:event.session}));
      provider.send(JSON.stringify({type:'response.created',response:{id:'worker-response'}}));
      provider.send(JSON.stringify({type:'response.done',response:{id:'worker-response',status:'completed',output:[{type:'function_call',id:'worker-item',call_id:'worker-call',name:'lookup',arguments:'{"value":7}'}]}}));
    }
    if(event.type==='response.create')finish();
  });
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response(null,{status:101,webSocket:pair[0]});
  let executions=0,approvals=0,credentialResolutions=0;
  let session;
  try {
    session=await connectPortableVoiceWorker({control:new NativeVoiceControl(module),apiKey:async()=>{credentialResolutions++;return 'synthetic-worker-key';},agent:{model:'test',instructions:async()=> 'Worker instructions',context:{tenant:'worker'},tools:[{name:'lookup',description:'Lookup',parameters:{type:'object'},needsApproval:true,execute:(args,signal,context)=>{executions++;return 'worker '+args.value+' '+context.history.length;}}],onApproval:async()=>{approvals++;return true;}}});
    await Promise.race([done,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Worker callback timeout')),5000))]);
    return Response.json({executions,approvals,credentialResolutions,output:frames.find(event=>event.item?.type==='function_call_output')?.item.output,frames:frames.map(event=>event.type)});
  }finally{await session?.close();provider.close();globalThis.fetch=originalFetch;}
}};`,
        resolveDir: process.cwd(),
      },
      external: ['control.wasm'],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
    });
    await writeFile(join(directory, 'worker.mjs'), bundle.outputFiles[0].text);
    await copyFile(
      process.env.OPENAI_AGENTS_PORTABLE_CONTROL_WASM!,
      join(directory, 'control.wasm'),
    );
    const reservation = createServer();
    await new Promise<void>((resolve) =>
      reservation.listen(0, '127.0.0.1', resolve),
    );
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    await writeFile(
      join(directory, 'config.capnp'),
      `using Workerd = import "/workerd/workerd.capnp"; const config :Workerd.Config = (services=[(name="main",worker=(modules=[(name="worker.mjs",esModule=embed "worker.mjs"),(name="control.wasm",wasm=embed "control.wasm")],compatibilityDate="2026-11-03"))],sockets=[(name="http",address="127.0.0.1:${port}",http=(),service="main")]);`,
    );
    const child = spawn(
      process.env.WORKERD_PATH!,
      ['serve', join(directory, 'config.capnp')],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let logs = '';
    child.stdout.on('data', (data) => (logs += data));
    child.stderr.on('data', (data) => (logs += data));
    try {
      let response: Response | undefined;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          response = await fetch(`http://127.0.0.1:${port}`, {
            signal: AbortSignal.timeout(8000),
          });
          break;
        } catch {
          if (child.exitCode !== null) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      expect(response, logs).toBeDefined();
      const result = await response!.json();
      expect(result).toEqual({
        executions: 1,
        approvals: 1,
        credentialResolutions: 1,
        output: 'worker 7 1',
        frames: [
          'session.update',
          'conversation.item.create',
          'response.create',
        ],
      });
    } finally {
      child.kill();
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) resolve();
        else child.once('exit', () => resolve());
      });
      await rm(directory, { recursive: true, force: true });
    }
  },
  20_000,
);
