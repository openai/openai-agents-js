import fs from 'node:fs';
import path from 'node:path';
import { Agent, run } from '@openai/agents';

const bisonImagePath = path.join(__dirname, 'media/image_bison.jpg');

function imageToBase64(imagePath: string): string {
  const imageBuffer = fs.readFileSync(imagePath);
  return imageBuffer.toString('base64');
}

async function main() {
  const agent = new Agent({
    name: 'Assistant',
    instructions: 'You are a helpful assistant.',
  });

  const b64Image = imageToBase64(bisonImagePath);
  const result = await run(agent, [
    {
      role: 'user',
      content: [
        {
          type: 'input_image',
          image: `data:image/jpeg;base64,${b64Image}`,
          providerData: {
            detail: 'auto',
          },
        },
      ],
    },
    {
      role: 'user',
      content: 'What do you see in this image?',
    },
  ]);

  console.log(result.finalOutput);
  // This image shows a large American bison standing on a grassy hill. The bison has a shaggy brown coat, with parts of its fur shedding, and prominent curved horns. The background is mostly a light, overcast sky, which makes the bison stand out prominently in the image. There is green grass and some small wild plants in the foreground. The overall scene appears natural and serene, likely in a prairie or grassland environment.
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
