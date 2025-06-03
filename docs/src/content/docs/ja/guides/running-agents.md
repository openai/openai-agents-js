---
title: エージェントの実行
description: Configure and execute agent workflows with the Runner class
---

Agents は単体では何もしません。`Runner` クラスで **実行** します。

```typescript title="Simple run"
import { Agent, Runner } from '@openai/agents';

const agent = new Agent({
  name: 'Assistant',
  instructions: 'You are a helpful assistant.',
});

const runner = new Runner();

const result = await runner.run(
  agent,
  'Write a haiku about recursion in programming.',
);

console.log(result.finalOutput);
// → Code within the code,\n   Functions calling themselves,\n   Infinite loop’s dance.
```

[Hello World の例](https://github.com/openai/openai-agents-js/tree/main/examples/basic/hello-world.ts) を参照してください。

### Runner ライフサイクル

アプリ起動時に `Runner` を作成し、そのインスタンスをリクエスト間で再利用します。このインスタンスにはモデルプロバイダーやトレーシングオプションなどのグローバル設定が保存されます。まったく異なる設定が必要な場合のみ新しい `Runner` を作成してください。簡単なスクリプトでは内部でデフォルトの runner を使用する `run()` を直接呼び出すこともできます。

---

## Runner API

### コンストラクター

```typescript
new Runner(config?: Partial<RunConfig>);
```

config を指定しない場合は、OpenAI プロバイダーやトレーシング有効などの妥当なデフォルトが選択されます。

### `run()`

```typescript
runner.run(agent, input, options?) → Promise<RunResult | StreamedRunResult>
```

- `agent` – 開始 [`Agent`](/openai-agents-js/ja/guides/agents) インスタンス
- `input` – プレーン文字列 **または** [`ResponseInputItem`](/openai/agents/type-aliases/modelrequest) オブジェクトの配列
- `options` – 下表を参照

| Option     | Default | 説明                                                                                    |
| ---------- | ------- | --------------------------------------------------------------------------------------- |
| `stream`   | `false` | `true` の場合、`StreamedRunResult` が返され、モデルから届いたイベントを随時 emit します |
| `context`  | –       | すべてのツール / ガードレール / ハンドオフに転送されるコンテキストオブジェクト          |
| `maxTurns` | `10`    | セーフティリミット – 超過すると `MaxTurnsExceededError` をスローします                  |
| `signal`   | –       | キャンセル用の `AbortSignal`                                                            |

`stream: true` の場合、`StreamedRunResult` を受け取ります。これは `AsyncIterable` であると同時に、最終回答を直接パイプする `toTextStream()` などのヘルパーも提供します。

```typescript title="Streaming example"
const streamed = await runner.run(agent, 'Tell me a joke', { stream: true });

for await (const event of streamed) {
  // Inspect tool calls, model deltas, …
}

// Or just pipe the text
streamed.toTextStream({ compatibleWithNodeStreams: true }).pipe(process.stdout);
```

詳細は [stream-text の例](https://github.com/openai/openai-agents-js/tree/main/examples/basic/stream-text.ts) をご覧ください。

---

## エージェントループ

`Runner.run()` は決定的なループを実装しています。

1. 現在の入力で現在のエージェントのモデルを呼び出す
2. LLM の応答を確認
   - **最終出力** → 返却
   - **ハンドオフ** → 新しいエージェントへ切り替え、会話履歴を保持して 1 へ
   - **ツール呼び出し** → ツールを実行し、その結果を会話に追加して 1 へ
3. `maxTurns` に達したら `MaxTurnsExceededError` をスロー

ループは、有効な _最終出力_（追加のツール呼び出しがなく、エージェントの `outputType` に一致）が生成されるまで繰り返されます。

---

## RunConfig

`RunConfig` は `Runner` インスタンスのグローバル動作を制御します。

| フィールド                  | 型                    | 目的                                                                   |
| --------------------------- | --------------------- | ---------------------------------------------------------------------- |
| `model`                     | `string \| Model`     | すべてのエージェントに対して特定のモデルを強制適用                     |
| `modelProvider`             | `ModelProvider`       | モデル名の解決 – デフォルトは OpenAI プロバイダー                      |
| `modelSettings`             | `ModelSettings`       | エージェントごとの設定より優先されるグローバルチューニングパラメーター |
| `handoffInputFilter`        | `HandoffInputFilter`  | ハンドオフ時に入力アイテムを変換（ハンドオフ側で定義がない場合）       |
| `inputGuardrails`           | `InputGuardrail[]`    | _初期_ ユーザー入力に適用されるガードレール                            |
| `outputGuardrails`          | `OutputGuardrail[]`   | _最終_ 出力に適用されるガードレール                                    |
| `tracingDisabled`           | `boolean`             | OpenAI トレーシングを完全に無効化                                      |
| `traceIncludeSensitiveData` | `boolean`             | span を出力しつつ LLM / ツールの入出力をトレースから除外               |
| `workflowName`              | `string`              | Traces ダッシュボードに表示され、関連する run をまとめるのに役立ちます |
| `traceId` / `groupId`       | `string`              | SDK による自動生成ではなく手動で trace / group ID を指定               |
| `traceMetadata`             | `Record<string, any>` | すべての span に付加する任意のメタデータ                               |

```typescript title="Custom Runner"
import { Runner } from '@openai/agents';
import { MyVectorSearchProvider } from './my_provider.js';

const runner = new Runner({
  workflowName: 'Customer‑support workflow',
  modelSettings: { temperature: 0.3 },
  modelProvider: new MyVectorSearchProvider(),
});
```

---

## 会話 / チャットスレッド

`runner.run()` への各呼び出しは、アプリケーションレベルの会話における 1 つの **ターン** を表します。エンドユーザーにどの程度の `RunResult` を表示するかは自由です。`finalOutput` だけを見せる場合もあれば、生成されたすべてのアイテムを見せる場合もあります。

```typescript
let thread: ResponseInputItem[] = [];

async function userSays(text: string) {
  const result = await runner.run(
    agent,
    thread.concat({ role: 'user', content: text }),
  );

  thread = result.output; // Carry over history + newly generated items
  return result.finalOutput;
}

await userSays('What city is the Golden Gate Bridge in?');
// → "San Francisco"

await userSays('What state is it in?');
// → "California"
```

インタラクティブ版は [chat の例](https://github.com/openai/openai-agents-js/tree/main/examples/basic/chat.ts) を参照してください。

---

## 例外

SDK はキャッチ可能な少数のエラーをスローします。

- `MaxTurnsExceededError` – `maxTurns` に到達
- `ModelBehaviorError` – モデルが無効な出力を生成（例: 不正な JSON、未知のツール）
- `InputGuardrailTripwireTriggered` / `OutputGuardrailTripwireTriggered` – ガードレール違反
- `GuardrailExecutionError` – ガードレールの実行に失敗
- `ToolCallError` – 関数ツール呼び出しでエラー発生

これらはすべて基底クラス `AgentsError` を継承しており、現在の run 状態にアクセスする `state` プロパティを提供することがあります。

以下は `GuardrailExecutionError` を処理するコード例です。

```typescript
import { z } from 'zod';
import {
  Agent,
  run,
  GuardrailExecutionError,
  InputGuardrail,
  InputGuardrailTripwireTriggered,
} from '@openai/agents';

const guardrailAgent = new Agent({
  name: 'Guardrail check',
  instructions: 'Check if the user is asking you to do their math homework.',
  outputType: z.object({
    isMathHomework: z.boolean(),
    reasoning: z.string(),
  }),
});

const unstableGuardrail: InputGuardrail = {
  name: 'Math Homework Guardrail (unstable)',
  execute: async () => {
    throw new Error('Something is wrong!');
  },
};

const fallbackGuardrail: InputGuardrail = {
  name: 'Math Homework Guardrail (fallback)',
  execute: async ({ input, context }) => {
    const result = await run(guardrailAgent, input, { context });
    return {
      outputInfo: result.finalOutput,
      tripwireTriggered: result.finalOutput?.isMathHomework ?? false,
    };
  },
};

const agent = new Agent({
  name: 'Customer support agent',
  instructions:
    'You are a customer support agent. You help customers with their questions.',
  inputGuardrails: [unstableGuardrail],
});

async function main() {
  try {
    const input = 'Hello, can you help me solve for x: 2x + 3 = 11?';
    const result = await run(agent, input);
    console.log(result.finalOutput);
  } catch (e) {
    if (e instanceof GuardrailExecutionError) {
      console.error(`Guardrail execution failed: ${e}`);
      // If you want to retry the execution with different settings,
      // you can reuse the runner's latest state this way:
      if (e.state) {
        try {
          agent.inputGuardrails = [fallbackGuardrail]; // fallback
          const result = await run(agent, e.state);
          console.log(result.finalOutput);
        } catch (ee) {
          if (ee instanceof InputGuardrailTripwireTriggered) {
            console.log('Math homework guardrail tripped');
          }
        }
      }
    } else {
      throw e;
    }
  }
}

main().catch(console.error);
```

上記の例を実行すると、次のような出力が得られます。

```
Guardrail execution failed: Error: Input guardrail failed to complete: Error: Something is wrong!
Math homework guardrail tripped
```

---

## 次のステップ

- [モデルを設定](/openai-agents-js/ja/guides/models) する方法を学ぶ
- エージェントに [tools](/openai-agents-js/ja/guides/tools) を提供する
- 本番環境に向けて [guardrails](/openai-agents-js/ja/guides/guardrails) や [tracing](/openai-agents-js/ja/guides/tracing) を追加する
