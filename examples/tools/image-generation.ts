import { Agent, run, imageGenerationTool, withTrace } from '@openai/agents';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

function openFile(filePath: string): void {
  if (process.platform === 'darwin') {
    spawnSync('open', [filePath], { stdio: 'inherit' });
  } else if (process.platform === 'win32') {
    spawnSync('cmd', ['/c', 'start', '', filePath], { shell: true });
  } else {
    spawnSync('xdg-open', [filePath], { stdio: 'inherit' });
  }
}

async function main() {
  const agent = new Agent({
    name: 'Image generator',
    instructions: 'You are a helpful agent.',
    tools: [imageGenerationTool({ quality: 'low', inputFidelity: 'high' })],
  });

  await withTrace('Image generation example', async () => {
    console.log('Generating image, this may take a while...');
    const result = await run(
      agent,
      'Create an image of a frog eating a pizza, comic book style. Return a text description of the image as a message too.',
    );
    console.log(result.finalOutput);

    for (const item of result.newItems) {
      if (
        item.type === 'tool_call_item' &&
        item.rawItem.type === 'hosted_tool_call' &&
        item.rawItem.output
      ) {
        const buffer = Buffer.from(item.rawItem.output, 'base64');
        const tmpPath = path.join(os.tmpdir(), `image-${Date.now()}.png`);
        fs.writeFileSync(tmpPath, buffer);
        // console.log(`Image saved to ${tmpPath}`);
        openFile(tmpPath);

        const revisedResult = await run(agent, [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: 'Change only the background of the given image to Japanese style.',
              },
              {
                type: 'input_image',
                image: 'data:image/png;base64,' + item.rawItem.output,
              },
            ],
          },
        ]);
        for (const revisedItem of revisedResult.newItems) {
          if (
            revisedItem.type === 'tool_call_item' &&
            revisedItem.rawItem.type === 'hosted_tool_call' &&
            revisedItem.rawItem.output
          ) {
            const buffer = Buffer.from(revisedItem.rawItem.output, 'base64');
            const tmpPath = path.join(os.tmpdir(), `image-${Date.now()}.png`);
            fs.writeFileSync(tmpPath, buffer);
            // console.log(`Image saved to ${tmpPath}`);
            openFile(tmpPath);
          }
        }
      }
    }
    // or using result.output works too
    // for (const response of result.output) {
    //   if (
    //     response.type === 'hosted_tool_call' &&
    //     response.name === 'image_generation_call' &&
    //     response.output
    //   ) {
    //     const buffer = Buffer.from(response.output, 'base64');
    //     const tmpPath = path.join(os.tmpdir(), `image-${Date.now()}.png`);
    //     fs.writeFileSync(tmpPath, buffer);
    //     // console.log(`Image saved to ${tmpPath}`);
    //     openFile(tmpPath);
    //   }
    // }
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
