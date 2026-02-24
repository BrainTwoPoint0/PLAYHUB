import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      'next/navigation': path.resolve(
        __dirname,
        './src/lib/__mocks__/next-navigation.ts'
      ),
      '@braintwopoint0/playback-commons/playerdata': path.resolve(
        __dirname,
        '../packages/commons/src/playerdata/index.ts'
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts'],
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    server: {
      deps: {
        inline: ['@braintwopoint0/playback-commons'],
      },
    },
  },
})
