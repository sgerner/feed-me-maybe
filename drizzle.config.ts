import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/lib/server/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    // Drizzle's schema is not the authoritative runtime schema. Keep CLI
    // commands away from DATABASE_URL, which may point at the reader's data.
    url: './data/drizzle-scratch.db',
  },
});
