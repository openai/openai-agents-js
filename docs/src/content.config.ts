import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({
      extend: z.object({
        canonicalHeadingIds: z
          .array(
            z.object({
              depth: z.number().int().min(2).max(6),
              id: z.string().min(1),
              aliases: z.array(z.string().min(1)),
            }),
          )
          .optional(),
      }),
    }),
  }),
};
