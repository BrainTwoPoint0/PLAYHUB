// Sync recordings from Spiideo to S3 and Supabase
// Single endpoint to handle all recording sync operations
// Protected by API key - intended to be called by Lambda cron job
import { NextResponse } from 'next/server'
import {
  getGames,
  getProductions,
  getOutputs,
  createDownloadOutput,
  getOutputProgress,
  getDownloadUri,
  type DownloadOutput,
} from '@/lib/spiideo/client'
import {
  uploadFromUrl,
  generateRecordingKey,
  getBucketName,
  moveFile,
  fileExists,
} from '@/lib/s3/client'
import { createServiceClient } from '@/lib/supabase/server'
import { sendRecordingReadyEmail } from '@/lib/email'

const ACCOUNT_ID = process.env.SPIIDEO_KUWAIT_ACCOUNT_ID!
const SYNC_API_KEY = process.env.SYNC_API_KEY

// Verify API key for protected endpoints
function verifyApiKey(request: Request): boolean {
  const apiKey = request.headers.get('x-api-key')
  return apiKey === SYNC_API_KEY && !!SYNC_API_KEY
}

interface SyncResult {
  gameId: string
  title: string
  matchDate: string
  status: 'synced' | 'transferred' | 'migrated' | 'error' | 'processing'
  message: string
  s3Key?: string
}

// GET - Check sync status
export async function GET(request: Request) {
  // Verify API key
  if (!verifyApiKey(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const supabase = createServiceClient() as any

    // Get existing recordings from database
    const { data: existingRecordings } = await supabase
      .from('playhub_match_recordings')
      .select(
        'id, title, match_date, s3_key, spiideo_game_id, spiideo_production_id'
      )
      .not('s3_key', 'is', null)

    const existingGameIds = new Set(
      existingRecordings?.map((r: any) => r.spiideo_game_id).filter(Boolean) ||
        []
    )

    // Get all finished games from Spiideo
    const games = await getGames(ACCOUNT_ID)
    const finishedGames = games.content.filter((g) => g.state === 'finished')

    // Check each game
    const status = await Promise.all(
      finishedGames.map(async (game) => {
        const inDatabase = existingGameIds.has(game.id)
        const dbRecord = existingRecordings?.find(
          (r: any) => r.spiideo_game_id === game.id
        )

        // Check if S3 path is correct (uses match date)
        let needsMigration = false
        if (dbRecord?.s3_key && dbRecord?.spiideo_production_id) {
          const correctKey = generateRecordingKey(
            game.id,
            dbRecord.spiideo_production_id,
            game.scheduledStartTime
          )
          needsMigration = dbRecord.s3_key !== correctKey
        }

        return {
          gameId: game.id,
          title: game.title || game.description,
          matchDate: game.scheduledStartTime,
          inDatabase,
          needsMigration,
          s3Key: dbRecord?.s3_key || null,
        }
      })
    )

    const needsSync = status.filter((s) => !s.inDatabase)
    const needsMigration = status.filter(
      (s) => s.inDatabase && s.needsMigration
    )
    const synced = status.filter((s) => s.inDatabase && !s.needsMigration)

    return NextResponse.json({
      total: status.length,
      synced: synced.length,
      needsSync: needsSync.length,
      needsMigration: needsMigration.length,
      games: status,
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

// POST - Run sync (optionally for a specific game)
export async function POST(request: Request) {
  // Verify API key
  if (!verifyApiKey(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const supabase = createServiceClient() as any

    // Check if syncing a specific game
    let specificGameId: string | null = null
    try {
      const body = await request.clone().json()
      specificGameId = body.gameId || null
    } catch {
      // No body, sync all
    }

    // Get existing recordings from database
    const { data: existingRecordings } = await supabase
      .from('playhub_match_recordings')
      .select(
        'id, title, match_date, s3_key, spiideo_game_id, spiideo_production_id'
      )
      .not('spiideo_game_id', 'is', null)

    const existingByGameId = new Map(
      existingRecordings?.map((r: any) => [r.spiideo_game_id, r]) || []
    )

    // Get all finished games from Spiideo
    const games = await getGames(ACCOUNT_ID)
    let finishedGames = games.content.filter((g) => g.state === 'finished')

    // If specific game requested, filter to just that one
    if (specificGameId) {
      finishedGames = finishedGames.filter((g) => g.id === specificGameId)
      if (finishedGames.length === 0) {
        return NextResponse.json(
          { error: `Game ${specificGameId} not found or not finished` },
          { status: 404 }
        )
      }
    }

    const results: SyncResult[] = []

    for (const game of finishedGames) {
      const existing = existingByGameId.get(game.id) as any

      if (existing) {
        // Check if needs migration (wrong S3 path)
        if (existing.s3_key && existing.spiideo_production_id) {
          const correctKey = generateRecordingKey(
            game.id,
            existing.spiideo_production_id,
            game.scheduledStartTime
          )

          if (existing.s3_key !== correctKey) {
            // Migrate to correct path
            try {
              const sourceExists = await fileExists(existing.s3_key)
              if (sourceExists) {
                await moveFile(existing.s3_key, correctKey)

                await supabase
                  .from('playhub_match_recordings')
                  .update({ s3_key: correctKey })
                  .eq('id', existing.id)

                results.push({
                  gameId: game.id,
                  title: game.title || game.description || 'Unknown',
                  matchDate: game.scheduledStartTime,
                  status: 'migrated',
                  message: `Moved to correct path`,
                  s3Key: correctKey,
                })
              } else {
                results.push({
                  gameId: game.id,
                  title: game.title || game.description || 'Unknown',
                  matchDate: game.scheduledStartTime,
                  status: 'error',
                  message: 'Source file not found in S3',
                })
              }
            } catch (err) {
              results.push({
                gameId: game.id,
                title: game.title || game.description || 'Unknown',
                matchDate: game.scheduledStartTime,
                status: 'error',
                message:
                  err instanceof Error ? err.message : 'Migration failed',
              })
            }
          } else {
            results.push({
              gameId: game.id,
              title: game.title || game.description || 'Unknown',
              matchDate: game.scheduledStartTime,
              status: 'synced',
              message: 'Already synced',
              s3Key: existing.s3_key,
            })
          }
        }
        continue
      }

      // New game - transfer from Spiideo to S3
      try {
        const result = await transferGame(game, supabase)
        results.push(result)
      } catch (err) {
        results.push({
          gameId: game.id,
          title: game.title || game.description || 'Unknown',
          matchDate: game.scheduledStartTime,
          status: 'error',
          message: err instanceof Error ? err.message : 'Transfer failed',
        })
      }
    }

    return NextResponse.json({
      total: results.length,
      synced: results.filter((r) => r.status === 'synced').length,
      transferred: results.filter((r) => r.status === 'transferred').length,
      migrated: results.filter((r) => r.status === 'migrated').length,
      processing: results.filter((r) => r.status === 'processing').length,
      errors: results.filter((r) => r.status === 'error').length,
      results,
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

// Transfer a single game from Spiideo to S3
async function transferGame(
  game: {
    id: string
    title?: string
    description?: string
    scheduledStartTime: string
  },
  supabase: any
): Promise<SyncResult> {
  // Get production
  const productions = await getProductions(game.id)
  const production = productions.content.find((p) => p.type === 'live')

  if (!production) {
    return {
      gameId: game.id,
      title: game.title || game.description || 'Unknown',
      matchDate: game.scheduledStartTime,
      status: 'error',
      message: 'No live production found',
    }
  }

  // Get or create download output
  const outputs = await getOutputs(production.id)
  let downloadOutput = outputs.content.find(
    (o) => o.outputType === 'download'
  ) as DownloadOutput | undefined

  if (!downloadOutput) {
    downloadOutput = await createDownloadOutput(production.id)
  }

  // Wait for download to be ready (up to 10 minutes)
  const maxWaitMs = 10 * 60 * 1000
  const pollIntervalMs = 5000
  const startTime = Date.now()

  while (Date.now() - startTime < maxWaitMs) {
    const progress = await getOutputProgress(downloadOutput.id)

    if (progress.progress >= 100) {
      break
    }

    if (Date.now() - startTime + pollIntervalMs >= maxWaitMs) {
      return {
        gameId: game.id,
        title: game.title || game.description || 'Unknown',
        matchDate: game.scheduledStartTime,
        status: 'processing',
        message: `Download processing (${progress.progress}%). Try again later.`,
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }

  // Get download URL and transfer to S3
  const downloadUri = await getDownloadUri(downloadOutput.id)
  const s3Key = generateRecordingKey(
    game.id,
    production.id,
    game.scheduledStartTime
  )

  const uploadResult = await uploadFromUrl(downloadUri, s3Key)

  // Save to Supabase
  const { data: upsertedRecording, error: dbError } = await supabase
    .from('playhub_match_recordings')
    .upsert(
      {
        spiideo_game_id: game.id,
        spiideo_production_id: production.id,
        title: game.title || game.description || 'Untitled',
        description: game.description,
        match_date: game.scheduledStartTime,
        home_team: 'Home',
        away_team: 'Away',
        s3_bucket: getBucketName(),
        s3_key: uploadResult.s3Key,
        file_size_bytes: uploadResult.size,
        status: 'published',
        access_type: 'private_link',
        transferred_at: new Date().toISOString(),
      },
      { onConflict: 'spiideo_game_id' }
    )
    .select('id, organization_id')
    .single()

  if (dbError) {
    return {
      gameId: game.id,
      title: game.title || game.description || 'Unknown',
      matchDate: game.scheduledStartTime,
      status: 'error',
      message: `Database save failed: ${dbError.message}`,
    }
  }

  // Notify users with access that the recording is ready
  if (upsertedRecording?.id) {
    await notifyUsersRecordingReady(
      supabase,
      upsertedRecording.id,
      game.title || game.description || 'Untitled',
      game.scheduledStartTime,
      upsertedRecording.organization_id
    )
  }

  return {
    gameId: game.id,
    title: game.title || game.description || 'Unknown',
    matchDate: game.scheduledStartTime,
    status: 'transferred',
    message: `Transferred ${Math.round(uploadResult.size / 1024 / 1024)}MB to S3`,
    s3Key: uploadResult.s3Key,
  }
}

// Notify all users with access that a recording is ready
async function notifyUsersRecordingReady(
  supabase: any,
  recordingId: string,
  recordingTitle: string,
  matchDate: string,
  organizationId?: string
) {
  try {
    // Get venue name
    let venueName: string | undefined
    if (organizationId) {
      const { data: venue } = await supabase
        .from('organizations')
        .select('name')
        .eq('id', organizationId)
        .single()
      venueName = venue?.name
    }

    // Get all users with access to this recording
    const { data: accessRights } = await supabase
      .from('playhub_access_rights')
      .select('user_id, invited_email')
      .eq('match_recording_id', recordingId)
      .eq('is_active', true)

    if (!accessRights || accessRights.length === 0) return

    // Get emails for users with user_id
    const userIds = accessRights
      .map((a: any) => a.user_id)
      .filter((id: string | null) => id !== null)

    let userEmails: string[] = []
    if (userIds.length > 0) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('email')
        .in('user_id', userIds)

      userEmails = profiles?.map((p: any) => p.email).filter(Boolean) || []
    }

    // Also include invited emails
    const invitedEmails = accessRights
      .map((a: any) => a.invited_email)
      .filter((email: string | null) => email !== null)

    const allEmails = Array.from(new Set([...userEmails, ...invitedEmails]))

    // Format match date
    const formattedDate = new Date(matchDate).toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })

    // Send emails
    await Promise.all(
      allEmails.map((email) =>
        sendRecordingReadyEmail({
          toEmail: email,
          recordingTitle,
          matchDate: formattedDate,
          venueName,
        })
      )
    )

    console.log(`Sent recording ready notifications to ${allEmails.length} users`)
  } catch (error) {
    console.error('Failed to send recording ready notifications:', error)
  }
}
