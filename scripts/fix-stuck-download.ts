// One-off script: delete stuck download output for Nazwa game and create a fresh one
// Usage: npx tsx scripts/fix-stuck-download.ts

// Load .env manually since dotenv isn't installed
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
const envPath = resolve(fileURLToPath(import.meta.url), '..', '..', '.env')
const envContent = readFileSync(envPath, 'utf-8')
for (const line of envContent.split('\n')) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) continue
  const eqIdx = trimmed.indexOf('=')
  if (eqIdx === -1) continue
  const key = trimmed.slice(0, eqIdx)
  const val = trimmed.slice(eqIdx + 1)
  if (!process.env[key]) process.env[key] = val
}

import {
  getGame,
  getProductions,
  getOutputs,
  getOutputProgress,
  deleteOutput,
  createDownloadOutput,
} from '../src/lib/spiideo/client'

const GAME_ID = 'c0fb7b4a-70c8-401e-a5f9-2bd0f56d41b2'

async function main() {
  console.log('Fetching game...')
  const game = await getGame(GAME_ID)
  console.log(`Game: ${game.title} | State: ${game.state}`)

  console.log('\nFetching productions...')
  const productions = await getProductions(GAME_ID)
  const liveProduction = productions.content.find((p) => p.type === 'live')

  if (!liveProduction) {
    console.error('No live production found!')
    process.exit(1)
  }

  console.log(`Production: ${liveProduction.id} | State: ${liveProduction.processingState}`)

  console.log('\nFetching outputs...')
  const outputs = await getOutputs(liveProduction.id)
  const downloadOutputs = outputs.content.filter((o) => o.outputType === 'download')

  console.log(`Found ${downloadOutputs.length} download output(s)`)

  for (const output of downloadOutputs) {
    const progress = await getOutputProgress(output.id)
    console.log(`  Output ${output.id}: ${progress.progress}%`)

    if (progress.progress < 100) {
      console.log(`  → Deleting stuck output ${output.id}...`)
      await deleteOutput(output.id)
      console.log(`  → Deleted`)
    }
  }

  console.log('\nCreating fresh download output...')
  const newOutput = await createDownloadOutput(liveProduction.id)
  console.log(`New output created: ${newOutput.id}`)

  // Check initial progress
  const initialProgress = await getOutputProgress(newOutput.id)
  console.log(`Initial progress: ${initialProgress.progress}%`)

  console.log('\nDone! The sync Lambda will pick this up on the next run (every 15 min).')
  console.log('Or monitor progress manually with:')
  console.log(`  npx tsx -e "import 'dotenv/config'; import {getOutputProgress} from './src/lib/spiideo/client'; getOutputProgress('${newOutput.id}').then(p => console.log(p.progress + '%'))"`)
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
