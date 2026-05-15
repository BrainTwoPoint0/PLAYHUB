/**
 * One-shot uploader for the LYL pilot logos.
 *
 * Reads from `~/Desktop/LYL-Logos/` (the source directory the user supplied),
 * uploads each file to the `graphic-packages` Supabase Storage bucket under a
 * normalized `lyl-<slug>.<ext>` name, and prints the public URLs needed by
 * the seed SQL that follows.
 *
 * Run once. Re-running is safe (upsert: true) but pointless — the seed SQL
 * pins the URLs.
 *
 * Usage:
 *   cd PLAYHUB && npx tsx scripts/upload-lyl-logos.ts
 *
 * Env required (loaded from .env):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from '@supabase/supabase-js'
import { readFile } from 'node:fs/promises'
import { join, extname, basename } from 'node:path'
import { homedir } from 'node:os'
import { config as loadEnv } from 'dotenv'

loadEnv({ path: join(__dirname, '..', '.env') })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_ROLE) {
  throw new Error(
    'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in PLAYHUB/.env'
  )
}

const BUCKET = 'graphic-packages'
const SOURCE_DIR = join(homedir(), 'Desktop', 'LYL-Logos')

// Source filename → (subclub_slug, destination basename). Maps the user's
// raw filenames to the slugs we'll seed into playhub_academy_subclubs +
// playhub_academy_config. Order matches the user's confirmed list (16 clubs
// + 1 league umbrella).
//
// `subclub_slug = null` ⇒ the row is the LYL umbrella (goes on
// playhub_academy_config.logo_url, not on a subclub row).
//
// The Chosen One source is converted to PNG separately (sips can't write
// WebP); we point at /tmp/lyl-chosen-one.png.
interface LogoEntry {
  source: string // absolute path
  subclubSlug: string | null
  destBasename: string // <slug>.<ext>
  displayName: string | null // for the seed SQL printout
  isUmbrella: boolean
}

const entries: LogoEntry[] = [
  // League umbrella (NOT a subclub).
  {
    source: join(SOURCE_DIR, 'image001.jpg'),
    subclubSlug: null,
    destBasename: 'lyl-league.jpg',
    displayName: null,
    isUmbrella: true,
  },
  // 16 subclubs.
  {
    source: join(SOURCE_DIR, 'Barnes Eagles.webp'),
    subclubSlug: 'barnes-eagles',
    destBasename: 'lyl-barnes-eagles.webp',
    displayName: 'Barnes Eagles',
    isUmbrella: false,
  },
  {
    source: join(SOURCE_DIR, 'Champs FC logo.jpg'),
    subclubSlug: 'champs-fc',
    destBasename: 'lyl-champs-fc.jpg',
    displayName: 'Champs FC',
    isUmbrella: false,
  },
  // AVIF source pre-converted to PNG (bucket disallows AVIF; sips won't
  // write WebP). PNG keeps the alpha channel for the crest.
  {
    source: '/tmp/lyl-chosen-one.png',
    subclubSlug: 'chosen-one',
    destBasename: 'lyl-chosen-one.png',
    displayName: 'Chosen One',
    isUmbrella: false,
  },
  {
    source: join(SOURCE_DIR, 'FC Juniors.jpg'),
    subclubSlug: 'fc-juniors',
    destBasename: 'lyl-fc-juniors.jpg',
    displayName: 'FC Juniors',
    isUmbrella: false,
  },
  {
    source: join(SOURCE_DIR, 'London Thames Logo.jpg'),
    subclubSlug: 'london-thames',
    destBasename: 'lyl-london-thames.jpg',
    displayName: 'London Thames',
    isUmbrella: false,
  },
  {
    source: join(SOURCE_DIR, 'National Harrow logo.png'),
    subclubSlug: 'national-harrow',
    destBasename: 'lyl-national-harrow.png',
    displayName: 'National Harrow',
    isUmbrella: false,
  },
  {
    source: join(SOURCE_DIR, 'Project 1v1 .jpg'),
    subclubSlug: 'project-1v1',
    destBasename: 'lyl-project-1v1.jpg',
    displayName: 'Project 1v1',
    isUmbrella: false,
  },
  {
    source: join(SOURCE_DIR, 'Storm Elite.jpg'),
    subclubSlug: 'storm-elite',
    destBasename: 'lyl-storm-elite.jpg',
    displayName: 'Storm Elite',
    isUmbrella: false,
  },
  {
    source: join(SOURCE_DIR, 'TAA Logo .jpg'),
    subclubSlug: 'taa',
    destBasename: 'lyl-taa.jpg',
    displayName: 'TAA',
    isUmbrella: false,
  },
  // Per the user: badge_9_2023_GNT_FINAL CROP.png is N.S.F.C.
  {
    source: join(SOURCE_DIR, 'badge_9_2023_GNT_FINAL CROP.png'),
    subclubSlug: 'nsfc',
    destBasename: 'lyl-nsfc.png',
    displayName: 'N.S.F.C',
    isUmbrella: false,
  },
  {
    source: join(SOURCE_DIR, 'dbx logo.jpg'),
    subclubSlug: 'dbx',
    destBasename: 'lyl-dbx.jpg',
    displayName: 'DBX',
    isUmbrella: false,
  },
  {
    source: join(SOURCE_DIR, 'ela new.jpg'),
    subclubSlug: 'ela',
    destBasename: 'lyl-ela.jpg',
    displayName: 'ELA',
    isUmbrella: false,
  },
  {
    source: join(SOURCE_DIR, 'jsfc logo.jpg'),
    subclubSlug: 'jsfc',
    destBasename: 'lyl-jsfc.jpg',
    displayName: 'JSFC',
    isUmbrella: false,
  },
  {
    source: join(SOURCE_DIR, 'lfs logo new.png'),
    subclubSlug: 'lfs',
    destBasename: 'lyl-lfs.png',
    displayName: 'LFS',
    isUmbrella: false,
  },
  {
    source: join(SOURCE_DIR, 'roehampton elite.jpg'),
    subclubSlug: 'roehampton-elite',
    destBasename: 'lyl-roehampton-elite.jpg',
    displayName: 'Roehampton Elite',
    isUmbrella: false,
  },
  {
    source: join(SOURCE_DIR, 'rpt logo.jpg'),
    subclubSlug: 'rpt',
    destBasename: 'lyl-rpt.jpg',
    displayName: 'RPT',
    isUmbrella: false,
  },
]

function mimeFor(ext: string): string {
  const e = ext.toLowerCase()
  if (e === '.png') return 'image/png'
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg'
  if (e === '.webp') return 'image/webp'
  throw new Error(`Unsupported extension ${ext}`)
}

async function main() {
  const supabase = createClient(SUPABASE_URL!, SERVICE_ROLE!)

  console.log(`Uploading ${entries.length} files to bucket "${BUCKET}"…\n`)
  const results: Array<{ entry: LogoEntry; publicUrl: string }> = []

  for (const entry of entries) {
    const buf = await readFile(entry.source)
    const ext = extname(entry.destBasename)
    const mime = mimeFor(ext)
    const objectKey = `lyl/${entry.destBasename}`

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(objectKey, buf, { contentType: mime, upsert: true })

    if (error) {
      console.error(`✗ ${basename(entry.source)} → ${objectKey}: ${error.message}`)
      throw error
    }

    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(objectKey)
    results.push({ entry, publicUrl: pub.publicUrl })
    const tag = entry.isUmbrella
      ? '[umbrella]'
      : `[${entry.subclubSlug}]`
    console.log(`✓ ${tag.padEnd(22)} ${objectKey}`)
  }

  console.log('\n--- Public URLs (paste into seed SQL) ---\n')
  for (const r of results) {
    if (r.entry.isUmbrella) {
      console.log(`-- LYL umbrella (academy_config row)`)
      console.log(`-- logo_url: '${r.publicUrl}'\n`)
    } else {
      console.log(`-- ${r.entry.displayName} (${r.entry.subclubSlug})`)
      console.log(`-- logo_url: '${r.publicUrl}'\n`)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
