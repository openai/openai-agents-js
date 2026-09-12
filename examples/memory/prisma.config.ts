import { defineConfig } from 'prisma/config';
import { resolvePrismaDatabaseUrl } from './prisma-database';

export default defineConfig({
  schema: './prisma/schema.prisma',
  datasource: {
    url: resolvePrismaDatabaseUrl(process.env.DATABASE_URL || 'file:./dev.db'),
  },
});
