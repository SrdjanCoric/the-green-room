import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Keep the suite stateless: back the Mastra instance with an in-memory
    // database so tests never read or grow the on-disk ./data/mastra.db.
    env: {
      INTERVIEW_COACH_DB_URL: ':memory:',
      // Tests drive the workflow with trusted fixture CV paths, so opt out of the
      // upload-directory confinement (which only guards untrusted server-side runs).
      INTERVIEW_COACH_TRUST_LOCAL_CV: '1',
    },
  },
});
