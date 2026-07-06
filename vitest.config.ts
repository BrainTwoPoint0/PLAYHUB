import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  // Next's tsconfig sets jsx: 'preserve' (required by Next). Vite 8/rolldown
  // respects that and refuses to transform JSX in imported .tsx files —
  // override to the automatic runtime for tests.
  oxc: {
    jsx: { runtime: 'automatic' },
  },
  resolve: {
    alias: {
      'next/navigation': path.resolve(
        __dirname,
        './src/lib/__mocks__/next-navigation.ts'
      ),
      // next-intl's ESM build imports the extensionless 'next/server',
      // which Node's ESM resolver rejects outside the Next runtime.
      'next/server': path.resolve(__dirname, './node_modules/next/server.js'),
      '@braintwopoint0/playback-commons/playerdata': path.resolve(
        __dirname,
        '../packages/commons/src/playerdata/index.ts'
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'infrastructure/**/__tests__/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts'],
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    server: {
      deps: {
        // next-intl must be inlined so the 'next/server' alias above applies
        // to its ESM imports.
        inline: ['@braintwopoint0/playback-commons', 'next-intl'],
      },
    },
  },
})
