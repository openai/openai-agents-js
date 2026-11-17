import { stdin, stdout } from 'node:process';
import * as readline from 'node:readline/promises';
import { prepareMcpExample, question } from './sdkManagedAgent';

async function main() {
  const { agent, runner, server } = await prepareMcpExample(true);
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    let result = await runner.run(agent, question);
    while (result.interruptions.length > 0) {
      for (const interruption of result.interruptions) {
        console.log(`Tool: ${interruption.name}`);
        console.log(`Arguments: ${interruption.arguments}`);
        const answer = await rl.question('Approve this MCP call? (y/n) ');
        if (answer.trim().toLowerCase() === 'y') {
          result.state.approve(interruption);
        } else {
          result.state.reject(interruption);
        }
      }
      result = await runner.run(agent, result.state);
    }
    console.log(result.finalOutput);
  } finally {
    rl.close();
    await server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
