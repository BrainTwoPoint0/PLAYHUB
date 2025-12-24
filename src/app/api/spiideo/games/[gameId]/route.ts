import { NextResponse } from 'next/server'
import {
  getGame,
  getProductions,
  getOutputs,
  getOutputLinks,
  createProduction,
  createDownloadOutput,
  getOutputProgress,
  getDownloadUri,
  setActiveAccount,
  type SpiideoAccountKey,
} from '@/lib/spiideo/client'

// GET - Get game details with productions and outputs
export async function GET(
  request: Request,
  { params }: { params: Promise<{ gameId: string }> }
) {
  const { gameId } = await params
  const { searchParams } = new URL(request.url)
  const accountKey =
    (searchParams.get('account') as SpiideoAccountKey) || 'kuwait'

  try {
    setActiveAccount(accountKey)

    // Get game details
    const game = await getGame(gameId)

    // Get productions for this game
    const productionsResponse = await getProductions(gameId)
    const productions = productionsResponse.content

    // Get outputs and links for each production
    const productionsWithOutputs = await Promise.all(
      productions.map(async (production) => {
        const outputsResponse = await getOutputs(production.id)
        const outputs = outputsResponse.content

        // Get links for each output
        const outputsWithLinks = await Promise.all(
          outputs.map(async (output) => {
            try {
              const linksResponse = await getOutputLinks(output.id, true)
              return {
                ...output,
                links: linksResponse.content,
              }
            } catch {
              return {
                ...output,
                links: [],
              }
            }
          })
        )

        return {
          ...production,
          outputs: outputsWithLinks,
        }
      })
    )

    return NextResponse.json({
      game,
      productions: productionsWithOutputs,
    })
  } catch (error) {
    console.error('Get game error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}

// POST - Create a production and download output for export
export async function POST(
  request: Request,
  { params }: { params: Promise<{ gameId: string }> }
) {
  const { gameId } = await params
  const { searchParams } = new URL(request.url)
  const accountKey =
    (searchParams.get('account') as SpiideoAccountKey) || 'kuwait'

  try {
    setActiveAccount(accountKey)

    // Get game details first
    const game = await getGame(gameId)

    // Check if production already exists
    const existingProductions = await getProductions(gameId)
    let production = existingProductions.content.find(
      (p) => p.type === 'static' && p.processingState === 'finished'
    )

    if (!production) {
      // Create a static production (for finished games)
      console.log(`Creating static production for game ${gameId}...`)
      production = await createProduction(gameId, {
        productionType: 'single_game',
        type: 'static',
        title: `Export - ${game.title}`,
      })
      console.log(`Production created: ${production.id}`)
    }

    // Check if download output already exists
    const existingOutputs = await getOutputs(production.id)
    let downloadOutput = existingOutputs.content.find(
      (o) => o.outputType === 'download'
    )

    if (!downloadOutput) {
      // Create download output
      console.log(`Creating download output for production ${production.id}...`)
      downloadOutput = await createDownloadOutput(production.id)
      console.log(`Download output created: ${downloadOutput.id}`)
    }

    // Check progress
    const progress = await getOutputProgress(downloadOutput.id)

    // If complete, get download URI
    let downloadUri = null
    if (progress.progress >= 100) {
      downloadUri = await getDownloadUri(downloadOutput.id)
    }

    return NextResponse.json({
      game,
      production,
      output: downloadOutput,
      progress: progress.progress,
      downloadUri,
      status:
        progress.progress >= 100
          ? 'ready'
          : progress.progress > 0
            ? 'processing'
            : 'pending',
    })
  } catch (error) {
    console.error('Export game error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
