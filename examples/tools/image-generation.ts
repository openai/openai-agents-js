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
    tools: [imageGenerationTool({ quality: 'low' })],
  });

  await withTrace('Image generation example', async () => {
    console.log('Generating image, this may take a while...');
    const result = await run(
      agent,
      'Create an image of a frog eating a pizza, comic book style. Return a text description of the image as a message too.',
    );
    console.log(result.finalOutput);

    const imageCall = result.newItems.find(
      (item) =>
        item.type === 'tool_call_item' &&
        item.rawItem.type === 'hosted_tool_call' &&
        item.rawItem.name === 'image_generation_call' &&
        item.rawItem.output,
    );
    if (
      !imageCall ||
      imageCall.rawItem.type !== 'hosted_tool_call' ||
      !imageCall.rawItem.output
    ) {
      throw new Error('Expected the image generation tool to return an image.');
    }

    const buffer = Buffer.from(imageCall.rawItem.output, 'base64');
    const tmpPath = path.join(os.tmpdir(), `image-${Date.now()}.png`);
    fs.writeFileSync(tmpPath, buffer);
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
            image: 'data:image/png;base64,' + imageCall.rawItem.output,
          },
        ],
      },
    ]);
    const revisedImageCall = revisedResult.newItems.find(
      (item) =>
        item.type === 'tool_call_item' &&
        item.rawItem.type === 'hosted_tool_call' &&
        item.rawItem.name === 'image_generation_call' &&
        item.rawItem.output,
    );
    if (
      !revisedImageCall ||
      revisedImageCall.rawItem.type !== 'hosted_tool_call' ||
      !revisedImageCall.rawItem.output
    ) {
      throw new Error('Expected the image edit to return a revised image.');
    }

    const revisedBuffer = Buffer.from(
      revisedImageCall.rawItem.output,
      'base64',
    );
    const revisedPath = path.join(
      os.tmpdir(),
      `revised-image-${Date.now()}.png`,
    );
    fs.writeFileSync(revisedPath, revisedBuffer);
    openFile(revisedPath);
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
