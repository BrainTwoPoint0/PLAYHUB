// Recordings API - List, get playback URLs, and backfill from S3
import { NextResponse } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import {
  getPlaybackUrl,
  getDownloadUrl,
  fileExists,
  getBucketName,
  generateRecordingKey,
} from '@/lib/s3/client'
import { getGames, getProductions } from '@/lib/spiideo/client'

const ACCOUNT_ID = process.env.SPIIDEO_KUWAIT_ACCOUNT_ID!
const SYNC_API_KEY = process.env.SYNC_API_KEY

// Verify API key for protected endpoints
function verifyApiKey(request: Request): boolean {
  const apiKey = request.headers.get('x-api-key')
  return apiKey === SYNC_API_KEY && !!SYNC_API_KEY
}

// Type for match recordings (not yet in generated types)
interface MatchRecording {
  id: string
  title: string
  description?: string
  match_date: string
  home_team: string
  away_team: string
  s3_bucket?: string
  s3_key?: string
  status: string
  spiideo_game_id?: string
  spiideo_production_id?: string
  transferred_at?: string
  created_at?: string
}

// GET - List recordings or get playback URL
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const id = searchParams.get('id')
  const action = searchParams.get('action')

  const supabase = (await createClient()) as any

  try {
    // Get playback URL for a specific recording
    if (id && action === 'playback') {
      const { data: recording, error } = await supabase
        .from('playhub_match_recordings')
        .select('*')
        .eq('id', id)
        .single()

      if (error || !recording) {
        return NextResponse.json(
          { error: 'Recording not found' },
          { status: 404 }
        )
      }

      if (!recording.s3_key) {
        return NextResponse.json(
          { error: 'Recording not available for playback' },
          { status: 400 }
        )
      }

      const playbackUrl = await getPlaybackUrl(recording.s3_key, 4 * 60 * 60) // 4 hours

      return NextResponse.json({
        id: recording.id,
        title: recording.title,
        playbackUrl,
        expiresIn: 4 * 60 * 60,
      })
    }

    // Get download URL for a specific recording
    if (id && action === 'download') {
      const { data: recording, error } = await supabase
        .from('playhub_match_recordings')
        .select('*')
        .eq('id', id)
        .single()

      if (error || !recording) {
        return NextResponse.json(
          { error: 'Recording not found' },
          { status: 404 }
        )
      }

      if (!recording.s3_key) {
        return NextResponse.json(
          { error: 'Recording not available for download' },
          { status: 400 }
        )
      }

      const filename = `${recording.title.replace(/[^a-zA-Z0-9]/g, '_')}.mp4`
      const downloadUrl = await getDownloadUrl(
        recording.s3_key,
        filename,
        60 * 60
      ) // 1 hour

      return NextResponse.json({
        id: recording.id,
        title: recording.title,
        downloadUrl,
        filename,
        expiresIn: 60 * 60,
      })
    }

    // Get single recording by ID
    if (id) {
      const { data: recording, error } = await supabase
        .from('playhub_match_recordings')
        .select('*')
        .eq('id', id)
        .single()

      if (error || !recording) {
        return NextResponse.json(
          { error: 'Recording not found' },
          { status: 404 }
        )
      }

      return NextResponse.json(recording)
    }

    // List all recordings
    const { data: recordings, error } = await supabase
      .from('playhub_match_recordings')
      .select('*')
      .order('match_date', { ascending: false })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({
      total: recordings?.length || 0,
      recordings,
    })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

// POST - Backfill database from S3 files (protected)
export async function POST(request: Request) {
  // Verify API key for admin operation
  if (!verifyApiKey(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { action } = body

    if (action !== 'backfill') {
      return NextResponse.json(
        { error: 'Invalid action. Use action: "backfill"' },
        { status: 400 }
      )
    }

    // Use service client to bypass RLS for admin operation
    const supabase = createServiceClient() as any

    // Get all finished games from Spiideo
    const games = await getGames(ACCOUNT_ID)
    const finishedGames = games.content.filter((g) => g.state === 'finished')

    const results: Array<{
      gameId: string
      title: string
      status: 'added' | 'exists' | 'no_s3' | 'error'
      message: string
      s3Key?: string
    }> = []

    for (const game of finishedGames) {
      try {
        // Check if already in database
        const { data: existing } = await supabase
          .from('playhub_match_recordings')
          .select('id')
          .eq('spiideo_game_id', game.id)
          .single()

        if (existing) {
          results.push({
            gameId: game.id,
            title: game.title,
            status: 'exists',
            message: 'Already in database',
          })
          continue
        }

        // Get production ID
        const productions = await getProductions(game.id)
        const liveProduction = productions.content.find(
          (p) => p.type === 'live'
        )

        if (!liveProduction) {
          results.push({
            gameId: game.id,
            title: game.title,
            status: 'error',
            message: 'No live production found',
          })
          continue
        }

        // Use the same key generation as the transfer endpoint (including match date)
        const s3Key = generateRecordingKey(game.id, liveProduction.id, game.scheduledStartTime)
        const inS3 = await fileExists(s3Key)

        if (!inS3) {
          results.push({
            gameId: game.id,
            title: game.title,
            status: 'no_s3',
            message: 'Not in S3',
            s3Key,
          })
          continue
        }

        // Add to database
        const { error: insertError } = await supabase
          .from('playhub_match_recordings')
          .insert({
            spiideo_game_id: game.id,
            spiideo_production_id: liveProduction.id,
            title: game.title,
            description: game.description,
            match_date: game.scheduledStartTime,
            home_team: 'Home',
            away_team: 'Away',
            s3_bucket: getBucketName(),
            s3_key: s3Key,
            status: 'published',
            transferred_at: new Date().toISOString(),
          })

        if (insertError) {
          results.push({
            gameId: game.id,
            title: game.title,
            status: 'error',
            message: insertError.message,
          })
        } else {
          results.push({
            gameId: game.id,
            title: game.title,
            status: 'added',
            message: 'Added to database',
            s3Key,
          })
        }
      } catch (error) {
        results.push({
          gameId: game.id,
          title: game.title,
          status: 'error',
          message: error instanceof Error ? error.message : 'Unknown error',
        })
      }
    }

    return NextResponse.json({
      total: results.length,
      added: results.filter((r) => r.status === 'added').length,
      exists: results.filter((r) => r.status === 'exists').length,
      noS3: results.filter((r) => r.status === 'no_s3').length,
      errors: results.filter((r) => r.status === 'error').length,
      results,
    })
  } catch (error: unknown) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
