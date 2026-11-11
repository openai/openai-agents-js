import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile, copyFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const enabled =
  Boolean(process.env.WORKERD_PATH) &&
  process.env.OPENAI_AGENTS_PORTABLE_TESTS === '1';

async function runWorker(contents: string): Promise<unknown> {
  const directory = await mkdtemp(join(tmpdir(), 'voice-direct-workerd-'));
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve('tsx'))('esbuild');
  const bundle = await build({
    stdin: {
      contents,
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
    expect(response!.status, logs).toBe(200);
    return await response!.json();
  } finally {
    child.kill();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
    await rm(directory, { recursive: true, force: true });
  }
}

it.runIf(enabled)(
  'executes Rust-owned direct voice through actual workerd WebSocketPair effects',
  async () => {
    const result = await runWorker(`
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
}};`);
    expect(result).toEqual({
      executions: 1,
      approvals: 1,
      credentialResolutions: 1,
      output: 'worker 7 1',
      frames: ['session.update', 'conversation.item.create', 'response.create'],
    });
  },
  20_000,
);

it.runIf(enabled)(
  'runs source-owned handoffs, guardrails and acknowledged history editing in workerd',
  async () => {
    const result = await runWorker(`
import module from 'control.wasm';
import {NativeVoiceControl} from ${JSON.stringify(resolve('packages/agents-codex/src/voice/portable.ts'))};
import {connectPortableVoiceWorker} from ${JSON.stringify(resolve('packages/agents-codex/src/voice/workerd.ts'))};
export default {async fetch() {
 const pair=new WebSocketPair();const provider=pair[1];provider.accept();
 const frames=[];const profiles=[];let continuations=0,handoffs=0,resolutions=0;
 const guardrailTexts=[];const contexts=[];
 let handoffDone,guardrailDone;
 const handoffFinished=new Promise(resolve=>handoffDone=resolve);
 const guardrailFinished=new Promise(resolve=>guardrailDone=resolve);
 provider.addEventListener('message',({data})=>{
  const event=JSON.parse(data);frames.push(event);
  if(event.type==='session.update'){
   profiles.push(event.session.instructions);
   provider.send(JSON.stringify({type:'session.updated',session:event.session}));
  }
  if(event.type==='conversation.item.create'&&event.item.type==='message')
   provider.send(JSON.stringify({type:'conversation.item.created',item:event.item,previous_item_id:event.previous_item_id??null}));
  if(event.type==='conversation.item.delete')
   provider.send(JSON.stringify({type:'conversation.item.deleted',item_id:event.item_id}));
  if(event.type==='response.cancel')
   provider.send(JSON.stringify({type:'response.done',response:{id:event.response_id,status:'cancelled',output:[]}}));
  if(event.type==='response.create'){
   continuations++;
   if(continuations===1)handoffDone();else guardrailDone();
  }
 });
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async()=>new Response(null,{status:101,webSocket:pair[0]});
 const target={name:'Target',model:'test',instructions:'Target instructions',context:{tenant:'target'},guardrailTextThreshold:1,outputGuardrails:[{name:'safety',callback:async(input)=>{guardrailTexts.push(input.text);return {tripwireTriggered:true};},feedback:'Answer safely'}]};
 let session;
 const bounded=promise=>Promise.race([promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Worker scenario timeout')),5000))]);
 try{
  session=await connectPortableVoiceWorker({control:new NativeVoiceControl(module),apiKey:async()=> 'synthetic-worker-key',agent:{name:'Root',model:'test',instructions:'Root instructions',context:{tenant:'worker'},handoffs:[{name:'transfer_custom',description:'Transfer',parameters:{type:'object'},agent:async(args,signal,context)=>{resolutions++;contexts.push([args.value,context.context.tenant]);return target;},onHandoff:async()=>{handoffs++;}}]}});
  await bounded(session.updateHistory([{id:'history-message',type:'message',role:'user',content:[{type:'input_text',text:'Remember'}]}]));
  const historyBefore=session.history.map(item=>item.id);
  await bounded(session.updateHistory([]));
  const historyAfter=session.history.map(item=>item.id);
  provider.send(JSON.stringify({type:'response.created',response:{id:'handoff-response'}}));
  provider.send(JSON.stringify({type:'response.done',response:{id:'handoff-response',status:'completed',output:[{type:'function_call',id:'handoff-item',call_id:'handoff-call',name:'transfer_custom',arguments:'{"value":7}'}]}}));
  await bounded(handoffFinished);
  provider.send(JSON.stringify({type:'response.created',response:{id:'guarded-response'}}));
  provider.send(JSON.stringify({type:'response.output_text.delta',response_id:'guarded-response',item_id:'guarded-item',content_index:0,delta:'blocked'}));
  await bounded(guardrailFinished);
  const cancelIndex=frames.findIndex(frame=>frame.type==='response.cancel');
  const replacementIndex=frames.findIndex(frame=>frame.type==='response.create'&&frame.response?.instructions==='Answer safely');
  return Response.json({handoffs,resolutions,contexts,guardrailTexts,profiles,historyBefore,historyAfter,frames:frames.map(frame=>frame.type),cancelBeforeReplacement:cancelIndex>=0&&replacementIndex>cancelIndex,feedback:frames[replacementIndex]?.response.instructions});
 }finally{await session?.close();provider.close();globalThis.fetch=originalFetch;}
}};
`);
    expect(result).toEqual({
      handoffs: 1,
      resolutions: 1,
      contexts: [[7, 'worker']],
      guardrailTexts: ['blocked'],
      profiles: ['Root instructions', 'Target instructions'],
      historyBefore: ['history-message'],
      historyAfter: [],
      frames: [
        'session.update',
        'conversation.item.create',
        'conversation.item.delete',
        'session.update',
        'conversation.item.create',
        'response.create',
        'response.cancel',
        'response.create',
      ],
      cancelBeforeReplacement: true,
      feedback: 'Answer safely',
    });
  },
  20_000,
);
