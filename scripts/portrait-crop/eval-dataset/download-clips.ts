/**
 * Download all manifest-listed clips into eval-dataset/clips/.
 *
 * Each clip entry's `notes` field carries `url=<veo cdn url>` — we curl that
 * to `<file>` under clips/. Clips whose source is `TBD_KARIM_PICKS_DURING_SPRINT`
 * are skipped (placeholders Karim populates during the sprint).
 *
 * Idempotent: skips clips that are already on disk.
 *
 * Usage:
 *   cd PLAYHUB && npx tsx scripts/portrait-crop/eval-dataset/download-clips.ts
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIPS_DIR = path.join(HERE, 'clips')
const MANIFEST = path.join(HERE, 'manifest.json')

interface ClipEntry {
  id: string
  file: string
  source: string
  notes?: string
}

function extractUrl(notes: string | undefined): string | null {
  if (!notes) return null
  const m = notes.match(/url=(https?:\/\/[^\s,]+)/)
  return m ? m[1] : null
}

function main() {
  fs.mkdirSync(CLIPS_DIR, { recursive: true })
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf-8')) as {
    clips: ClipEntry[]
  }

  let downloaded = 0
  let skipped = 0
  let placeholders = 0

  for (const clip of manifest.clips) {
    if (clip.source === 'TBD_KARIM_PICKS_DURING_SPRINT') {
      console.log(`[placeholder] ${clip.id} — pick during sprint, skipping`)
      placeholders++
      continue
    }
    const dest = path.join(CLIPS_DIR, clip.file)
    if (fs.existsSync(dest)) {
      console.log(`[have]        ${clip.file}`)
      skipped++
      continue
    }
    const url = extractUrl(clip.notes)
    if (!url) {
      console.warn(`[no-url]      ${clip.id}: no url= in notes; skipping`)
      continue
    }
    console.log(`[download]    ${clip.file} ← ${url}`)
    try {
      // Veo CDN URLs include a ?v=signature query — quote heavily.
      execSync(`curl -fsSL --max-time 120 -o "${dest}" "${url}"`, {
        stdio: 'inherit',
      })
      downloaded++
    } catch (err) {
      console.error(`[fail]        ${clip.file}: ${err}`)
      // Don't leave a partial file behind.
      try {
        fs.unlinkSync(dest)
      } catch {
        /* ignore */
      }
    }
  }

  console.log(
    `\nDone. downloaded=${downloaded} already-present=${skipped} placeholders=${placeholders}`
  )
  console.log(`Clips dir: ${CLIPS_DIR}`)
}

main()
