import { readFileSync } from 'fs'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
const envPath = resolve(fileURLToPath(import.meta.url), '..', '..', '.env')
const envContent = readFileSync(envPath, 'utf-8')
for (const line of envContent.split('\n')) {
  const t = line.trim()
  if (t.length === 0 || t.startsWith('#')) continue
  const i = t.indexOf('=')
  if (i === -1) continue
  const key = t.slice(0, i)
  if (process.env[key] === undefined) process.env[key] = t.slice(i + 1)
}

import { getOutputProgress } from '../src/lib/spiideo/client'

const outputId = 'b95d55fd-6765-4be0-beb2-0ec6a7affcb8'
getOutputProgress(outputId).then((p) =>
  console.log(`Download progress: ${p.progress}%`)
)
