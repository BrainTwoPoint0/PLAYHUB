// Spiideo API Client for PLAYHUB
// Handles OAuth2 authentication and API calls to Spiideo
// Supports multiple Spiideo accounts (Play and Perform)

const SPIIDEO_API_BASE = 'https://api-public.spiideo.com'
const SPIIDEO_TOKEN_URL = 'https://auth-play.spiideo.net/oauth2/token'

// ============================================================================
// Types
// ============================================================================

// Supported Spiideo account configurations
export type SpiideoAccountKey = 'kuwait' | 'dubai'

interface TokenResponse {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token?: string
  scope?: string
}

interface SpiideoConfig {
  clientId: string
  clientSecret: string
  clientName: string
  userId: string
  accountId?: string
  sceneId?: string
  recipeId?: string
  type: 'play' | 'perform'
}

// Spiideo Sport Types
export type SpiideoSport =
  | 'american_football'
  | 'athletics'
  | 'badminton'
  | 'bandy'
  | 'baseball'
  | 'basketball'
  | 'boxing'
  | 'fencing'
  | 'field_hockey'
  | 'figure_skating'
  | 'floorball'
  | 'football'
  | 'futsal'
  | 'gaelic_football'
  | 'gym'
  | 'gymnastics'
  | 'handball'
  | 'ice_hockey'
  | 'judo'
  | 'kabaddi'
  | 'karate'
  | 'kho_kho'
  | 'kurash'
  | 'lacrosse'
  | 'mma'
  | 'netball'
  | 'other'
  | 'rugby'
  | 'skating'
  | 'softball'
  | 'speed_cubing'
  | 'squash'
  | 'swimming'
  | 'table_tennis'
  | 'taekwondo'
  | 'throwball'
  | 'tennis'
  | 'volleyball'
  | 'water_polo'
  | 'wrestling'
  | 'yoga'

// Game States
export type GameState =
  | 'created'
  | 'scheduled'
  | 'recording'
  | 'finished'
  | 'purged'
  | 'aborted'
  | 'eradicated'

// Production States
export type ProductionState =
  | 'pending'
  | 'starting'
  | 'processing'
  | 'finished'
  | 'purged'
  | 'error'
  | 'deleted'

// Production Types
export type ProductionType = 'live' | 'static' | 'low-latency'

// Output Types
export type OutputType = 'download' | 'push_stream' | 'external_hls'

// Account
export interface SpiideoAccount {
  id: string
  name: string
  type: 'play' | 'perform' | 'league'
}

// Game/Match
export interface SpiideoGame {
  id: string
  accountId: string
  title: string
  description: string
  sport: SpiideoSport
  state: GameState
  sceneId: string
  homeTeamId?: string
  awayTeamId?: string
  scheduledStartTime: string
  scheduledStopTime: string
  eventStartTime?: string
}

// Create Game Input
export interface CreateGameInput {
  accountId: string
  title: string
  description: string
  sport: SpiideoSport
  sceneId: string
  scheduledStartTime: string // ISO 8601
  scheduledStopTime: string // ISO 8601
  homeTeamId?: string
  awayTeamId?: string
  eventStartTime?: string
  accessAccountId?: string // For league accounts
}

// Production
export interface SpiideoProduction {
  id: string
  gameId: string
  productionType: 'single_game'
  type: ProductionType
  processingState: ProductionState
  title?: string
  cloudStudioUrl?: string
  productionRecipeId?: string
  storyboardId?: string
  graphicPackageId?: string
  highlightsSource?: boolean
}

// Create Production Input
export interface CreateProductionInput {
  productionType: 'single_game'
  type: ProductionType
  title?: string
  productionRecipeId?: string
  storyboardId?: string
  graphicPackageId?: string
  highlightsSource?: boolean
}

// Output Base
export interface SpiideoOutput {
  id: string
  productionId: string
  outputType: OutputType
}

// Push Stream Output (RTMP/SRT)
export interface PushStreamOutput extends SpiideoOutput {
  outputType: 'push_stream'
  name?: string
  uri: string // RTMP or SRT URL
}

// Download Output (Recording)
export interface DownloadOutput extends SpiideoOutput {
  outputType: 'download'
  publishable: boolean
  timeCreated: string
}

// External HLS Output
export interface ExternalHlsOutput extends SpiideoOutput {
  outputType: 'external_hls'
}

// Create Push Stream Output Input
export interface CreatePushStreamInput {
  outputType: 'push_stream'
  name?: string
  uri: string // e.g., rtmp://example.com/live/streamkey
}

// Create Download Output Input
export interface CreateDownloadInput {
  outputType: 'download'
}

// Output Link (Shareable link)
export interface OutputLink {
  id: string
  uri: string
  validFrom?: string
  validTo?: string
  maxUses?: number
  uses: number
}

// Create Output Link Input
export interface CreateOutputLinkInput {
  validFrom?: string
  validTo?: string
  maxUses?: number
}

// Output Progress
export interface OutputProgress {
  progress: number // 0-100
}

// Scene (Recording location/camera setup)
export interface SpiideoScene {
  id: string
  name: string
  accountId: string
}

// Production Recipe (Template for production settings)
export interface ProductionRecipe {
  id: string
  accountId: string
  sport: SpiideoSport
  graphicPackageId?: string
}

// Paginated Response
export interface PagedResponse<T> {
  content: T[]
  nextParameters?: {
    nextToken?: string
    pageSize?: number
  }
}

// ============================================================================
// Token Cache (per account)
// ============================================================================

const tokenCache: Record<string, { token: string; expiresAt: number }> = {}

// Current active account (default to Kuwait for backwards compatibility)
let activeAccount: SpiideoAccountKey = 'kuwait'

// ============================================================================
// Configuration
// ============================================================================

const ACCOUNT_CONFIGS: Record<SpiideoAccountKey, () => SpiideoConfig> = {
  kuwait: () => {
    const clientId = process.env.SPIIDEO_KUWAIT_CLIENT_ID
    const clientSecret = process.env.SPIIDEO_KUWAIT_CLIENT_SECRET
    const clientName = process.env.SPIIDEO_KUWAIT_CLIENT_NAME
    const userId = process.env.SPIIDEO_PLAYBACK_ADMIN_USER_ID

    if (!clientId || !clientSecret) {
      throw new Error('Spiideo Kuwait client credentials not configured')
    }
    if (!userId) {
      throw new Error(
        'Spiideo user ID not configured (SPIIDEO_PLAYBACK_ADMIN_USER_ID)'
      )
    }

    return {
      clientId,
      clientSecret,
      clientName: clientName || 'playhub',
      userId,
      accountId: process.env.SPIIDEO_KUWAIT_ACCOUNT_ID,
      sceneId: process.env.SPIIDEO_KUWAIT_SCENE_ID,
      recipeId: process.env.SPIIDEO_KUWAIT_RECIPE_ID,
      type: 'play' as const,
    }
  },
  dubai: () => {
    const clientId = process.env.SPIIDEO_PERFORM_DUBAI_CLIENT_ID
    const clientSecret = process.env.SPIIDEO_PERFORM_DUBAI_CLIENT_SECRET
    const clientName = process.env.SPIIDEO_PERFORM_DUBAI_CLIENT_NAME
    const userId = process.env.SPIIDEO_PLAYBACK_ADMIN_USER_ID

    if (!clientId || !clientSecret) {
      throw new Error('Spiideo Dubai Perform client credentials not configured')
    }
    if (!userId) {
      throw new Error(
        'Spiideo user ID not configured (SPIIDEO_PLAYBACK_ADMIN_USER_ID)'
      )
    }

    return {
      clientId,
      clientSecret,
      clientName: clientName || 'playhub',
      userId,
      accountId: process.env.SPIIDEO_PERFORM_DUBAI_ACCOUNT_ID,
      sceneId: process.env.SPIIDEO_PERFORM_DUBAI_SCENE_ID,
      recipeId: process.env.SPIIDEO_PERFORM_DUBAI_RECIPE_ID,
      type: 'perform' as const,
    }
  },
}

function getConfig(account?: SpiideoAccountKey): SpiideoConfig {
  const key = account || activeAccount
  return ACCOUNT_CONFIGS[key]()
}

/**
 * Set the active Spiideo account for subsequent API calls
 */
export function setActiveAccount(account: SpiideoAccountKey): void {
  activeAccount = account
}

/**
 * Get the current active Spiideo account
 */
export function getActiveAccount(): SpiideoAccountKey {
  return activeAccount
}

/**
 * Get configuration for a specific account
 */
export function getAccountConfig(account?: SpiideoAccountKey): SpiideoConfig {
  return getConfig(account)
}

export function getSpiideoUserId(account?: SpiideoAccountKey): string {
  return getConfig(account).userId
}

// ============================================================================
// Authentication
// ============================================================================

async function getAccessToken(account?: SpiideoAccountKey): Promise<string> {
  const key = account || activeAccount
  const cached = tokenCache[key]

  // Check cache first - 5 min buffer before expiry
  if (cached && Date.now() < cached.expiresAt - 300000) {
    return cached.token
  }

  const config = getConfig(key)
  const basicAuth = Buffer.from(
    `${config.clientId}:${config.clientSecret}`
  ).toString('base64')

  const response = await fetch(SPIIDEO_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
    }),
    cache: 'no-store',
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      `Failed to get Spiideo access token for ${key}: ${response.status} - ${errorText}`
    )
  }

  const data: TokenResponse = await response.json()

  tokenCache[key] = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  }

  return data.access_token
}

// ============================================================================
// Base Request Function
// ============================================================================

async function spiideoRequest<T>(
  endpoint: string,
  options: {
    method?: string
    body?: unknown
    account?: SpiideoAccountKey
  } = {}
): Promise<T> {
  const account = options.account || activeAccount
  const token = await getAccessToken(account)
  const config = getConfig(account)

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    accept: 'application/json',
    'X-Spiideo-Api-User': config.userId,
  }

  const response = await fetch(`${SPIIDEO_API_BASE}${endpoint}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: 'no-store',
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      `Spiideo API error (${account}): ${response.status} - ${errorText}`
    )
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return undefined as T
  }

  return response.json()
}

// ============================================================================
// Connection Test
// ============================================================================

export async function testConnection(account?: SpiideoAccountKey): Promise<{
  success: boolean
  message: string
  account: SpiideoAccountKey
  accountType: 'play' | 'perform'
  tokenUrl?: string
  error?: string
}> {
  const key = account || activeAccount
  try {
    await getAccessToken(key)
    const config = getConfig(key)
    return {
      success: true,
      message: `Successfully connected to Spiideo API (${key})`,
      account: key,
      accountType: config.type,
      tokenUrl: SPIIDEO_TOKEN_URL,
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    const config = getConfig(key)
    return {
      success: false,
      message: `Failed to connect to Spiideo API (${key})`,
      account: key,
      accountType: config.type,
      tokenUrl: SPIIDEO_TOKEN_URL,
      error: message,
    }
  }
}

/**
 * Test connections to all configured Spiideo accounts
 */
export async function testAllConnections(): Promise<{
  kuwait: Awaited<ReturnType<typeof testConnection>>
  dubai: Awaited<ReturnType<typeof testConnection>>
}> {
  const [kuwait, dubai] = await Promise.all([
    testConnection('kuwait'),
    testConnection('dubai'),
  ])
  return { kuwait, dubai }
}

// ============================================================================
// Account Functions
// ============================================================================

export async function getAccounts(
  type: 'play' | 'perform' | 'league' = 'play'
): Promise<PagedResponse<SpiideoAccount>> {
  return spiideoRequest<PagedResponse<SpiideoAccount>>(
    `/v1/accounts?type=${type}`
  )
}

// ============================================================================
// Scene Functions
// ============================================================================

export async function getScenes(
  accountId: string
): Promise<PagedResponse<SpiideoScene>> {
  return spiideoRequest<PagedResponse<SpiideoScene>>(
    `/v1/scenes?accountId=${accountId}`
  )
}

// ============================================================================
// Production Recipe Functions
// ============================================================================

export async function getProductionRecipes(
  accountId: string
): Promise<PagedResponse<ProductionRecipe>> {
  return spiideoRequest<PagedResponse<ProductionRecipe>>(
    `/v1/accounts/${accountId}/production-recipes`
  )
}

// ============================================================================
// Game Functions
// ============================================================================

export async function getGames(
  accountId: string,
  options?: {
    from?: string
    to?: string
    sceneId?: string
    titleSearch?: string
  }
): Promise<PagedResponse<SpiideoGame>> {
  const params = new URLSearchParams({ accountId })
  if (options?.from) params.append('from', options.from)
  if (options?.to) params.append('to', options.to)
  if (options?.sceneId) params.append('sceneId', options.sceneId)
  if (options?.titleSearch) params.append('titleSearch', options.titleSearch)

  return spiideoRequest<PagedResponse<SpiideoGame>>(
    `/v1/games?${params.toString()}`
  )
}

export async function getGame(gameId: string): Promise<SpiideoGame> {
  return spiideoRequest<SpiideoGame>(`/v1/games/${gameId}`)
}

export async function createGame(input: CreateGameInput): Promise<SpiideoGame> {
  return spiideoRequest<SpiideoGame>('/v1/games', {
    method: 'POST',
    body: input,
  })
}

export async function deleteGame(gameId: string): Promise<void> {
  await spiideoRequest<void>(`/v1/games/${gameId}`, {
    method: 'DELETE',
  })
}

// Update Game Input (all fields optional)
export interface UpdateGameInput {
  title?: string
  description?: string
  scheduledStartTime?: string
  scheduledStopTime?: string
  eventStartTime?: string
  homeTeamId?: string
  awayTeamId?: string
  sceneId?: string
  sport?: SpiideoSport
}

export async function updateGame(
  gameId: string,
  input: UpdateGameInput
): Promise<SpiideoGame> {
  // Convert to Spiideo's patch format
  // Each field update requires: { action: 'replace', value: ... }
  const patchBody: Record<string, unknown> = {
    action: 'updateGame',
  }

  // Only include fields that are provided - each needs action: 'replace'
  if (input.title !== undefined)
    patchBody.title = { action: 'replace', value: input.title }
  if (input.description !== undefined)
    patchBody.description = { action: 'replace', value: input.description }
  if (input.scheduledStartTime !== undefined)
    patchBody.scheduledStartTime = {
      action: 'replace',
      value: input.scheduledStartTime,
    }
  if (input.scheduledStopTime !== undefined)
    patchBody.scheduledStopTime = {
      action: 'replace',
      value: input.scheduledStopTime,
    }
  if (input.eventStartTime !== undefined)
    patchBody.eventStartTime = {
      action: 'replace',
      value: input.eventStartTime,
    }
  if (input.homeTeamId !== undefined)
    patchBody.homeTeamId = { action: 'replace', value: input.homeTeamId }
  if (input.awayTeamId !== undefined)
    patchBody.awayTeamId = { action: 'replace', value: input.awayTeamId }
  if (input.sceneId !== undefined)
    patchBody.sceneId = { action: 'replace', value: input.sceneId }
  if (input.sport !== undefined)
    patchBody.sport = { action: 'replace', value: input.sport }

  return spiideoRequest<SpiideoGame>(`/v1/games/${gameId}`, {
    method: 'PATCH',
    body: patchBody,
  })
}

/**
 * Stop a game by setting the scheduledStopTime to 1 minute from now
 * Spiideo requires stop time to be in the future, so we can't stop immediately
 */
export async function stopGame(gameId: string): Promise<SpiideoGame> {
  const stopTime = new Date(Date.now() + 60 * 1000) // 1 minute from now
  return updateGame(gameId, {
    scheduledStopTime: stopTime.toISOString(),
  })
}

// ============================================================================
// Production Functions
// ============================================================================

export async function getProductions(
  gameId: string,
  type?: ProductionType
): Promise<PagedResponse<SpiideoProduction>> {
  const params = type ? `?type=${type}` : ''
  return spiideoRequest<PagedResponse<SpiideoProduction>>(
    `/v1/games/${gameId}/productions${params}`
  )
}

export async function getProduction(
  productionId: string
): Promise<SpiideoProduction> {
  return spiideoRequest<SpiideoProduction>(`/v1/productions/${productionId}`)
}

export async function createProduction(
  gameId: string,
  input: CreateProductionInput
): Promise<SpiideoProduction> {
  return spiideoRequest<SpiideoProduction>(`/v1/games/${gameId}/productions`, {
    method: 'POST',
    body: input,
  })
}

export async function deleteProduction(productionId: string): Promise<void> {
  await spiideoRequest<void>(`/v1/productions/${productionId}`, {
    method: 'DELETE',
  })
}

// ============================================================================
// Output Functions
// ============================================================================

export async function getOutputs(
  productionId: string
): Promise<PagedResponse<SpiideoOutput>> {
  return spiideoRequest<PagedResponse<SpiideoOutput>>(
    `/v1/productions/${productionId}/outputs`
  )
}

export async function createPushStreamOutput(
  productionId: string,
  uri: string,
  name?: string
): Promise<PushStreamOutput> {
  const input: CreatePushStreamInput = {
    outputType: 'push_stream',
    uri,
    name,
  }
  return spiideoRequest<PushStreamOutput>(
    `/v1/productions/${productionId}/outputs`,
    {
      method: 'POST',
      body: input,
    }
  )
}

export async function createDownloadOutput(
  productionId: string
): Promise<DownloadOutput> {
  const input: CreateDownloadInput = {
    outputType: 'download',
  }
  return spiideoRequest<DownloadOutput>(
    `/v1/productions/${productionId}/outputs`,
    {
      method: 'POST',
      body: input,
    }
  )
}

export async function deleteOutput(outputId: string): Promise<void> {
  await spiideoRequest<void>(`/v1/outputs/${outputId}`, {
    method: 'DELETE',
  })
}

export async function getOutputProgress(
  outputId: string
): Promise<OutputProgress> {
  // API returns raw integer, not an object
  const progress = await spiideoRequest<number>(
    `/v1/outputs/${outputId}/progress`
  )
  return { progress }
}

export async function getDownloadUri(outputId: string): Promise<string> {
  return spiideoRequest<string>(`/v1/outputs/${outputId}/download-uri`)
}

// ============================================================================
// Output Link Functions (Shareable Links)
// ============================================================================

export async function getOutputLinks(
  outputId: string,
  includeExpired: boolean = false
): Promise<PagedResponse<OutputLink>> {
  return spiideoRequest<PagedResponse<OutputLink>>(
    `/v1/outputs/${outputId}/output-links?includeExpired=${includeExpired}`
  )
}

export async function createOutputLink(
  outputId: string,
  input?: CreateOutputLinkInput
): Promise<OutputLink> {
  return spiideoRequest<OutputLink>(`/v1/outputs/${outputId}/output-links`, {
    method: 'POST',
    body: input || {},
  })
}

export async function getOutputLink(outputLinkId: string): Promise<OutputLink> {
  return spiideoRequest<OutputLink>(`/v1/output-links/${outputLinkId}`)
}

export async function invalidateOutputLink(
  outputLinkId: string
): Promise<OutputLink> {
  return spiideoRequest<OutputLink>(
    `/v1/output-links/${outputLinkId}/invalidate`,
    {
      method: 'PUT',
    }
  )
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Build an RTMP URL with stream key for push streaming
 */
export function buildRtmpUrl(baseUrl: string, streamKey: string): string {
  // Ensure URL doesn't end with slash
  const cleanUrl = baseUrl.replace(/\/$/, '')
  return `${cleanUrl}/${streamKey}`
}

/**
 * Create a live production with RTMP push output
 * This is the main function for setting up a broadcast from Spiideo to PLAYHUB
 */
export async function setupLiveBroadcast(
  gameId: string,
  rtmpUrl: string,
  options?: {
    productionRecipeId?: string
    title?: string
  }
): Promise<{
  production: SpiideoProduction
  output: PushStreamOutput
}> {
  // Create a live production
  const production = await createProduction(gameId, {
    productionType: 'single_game',
    type: 'live',
    title: options?.title,
    productionRecipeId: options?.productionRecipeId,
  })

  // Create push stream output to our RTMP endpoint
  const output = await createPushStreamOutput(
    production.id,
    rtmpUrl,
    'PLAYHUB Live Stream'
  )

  return { production, output }
}

/**
 * Create a download output for recording
 * Use this to generate a downloadable recording after a game
 */
export async function setupRecordingDownload(
  productionId: string
): Promise<DownloadOutput> {
  return createDownloadOutput(productionId)
}

/**
 * Get a shareable link for a recording
 * Creates a time-limited link for sharing match recordings
 */
export async function createShareableLink(
  outputId: string,
  options?: {
    validForHours?: number
    maxUses?: number
  }
): Promise<OutputLink> {
  const input: CreateOutputLinkInput = {}

  if (options?.validForHours) {
    const validTo = new Date()
    validTo.setHours(validTo.getHours() + options.validForHours)
    input.validTo = validTo.toISOString()
  }

  if (options?.maxUses) {
    input.maxUses = options.maxUses
  }

  return createOutputLink(outputId, input)
}

/**
 * Wait for a download output to be ready
 * Polls the progress endpoint until complete
 */
export async function waitForDownloadReady(
  outputId: string,
  options?: {
    pollIntervalMs?: number
    timeoutMs?: number
    onProgress?: (progress: number) => void
  }
): Promise<string> {
  const pollInterval = options?.pollIntervalMs || 5000
  const timeout = options?.timeoutMs || 600000 // 10 minutes default
  const startTime = Date.now()

  while (Date.now() - startTime < timeout) {
    const { progress } = await getOutputProgress(outputId)

    if (options?.onProgress) {
      options.onProgress(progress)
    }

    if (progress >= 100) {
      return getDownloadUri(outputId)
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval))
  }

  throw new Error(`Download timeout after ${timeout}ms`)
}

// ============================================================================
// Export Client Object
// ============================================================================

export const spiideoClient = {
  // Multi-account management
  setActiveAccount,
  getActiveAccount,
  getAccountConfig,
  testAllConnections,

  // Connection
  testConnection,
  getSpiideoUserId,

  // Accounts
  getAccounts,

  // Scenes
  getScenes,

  // Production Recipes
  getProductionRecipes,

  // Games
  getGames,
  getGame,
  createGame,
  updateGame,
  stopGame,
  deleteGame,

  // Productions
  getProductions,
  getProduction,
  createProduction,
  deleteProduction,

  // Outputs
  getOutputs,
  createPushStreamOutput,
  createDownloadOutput,
  deleteOutput,
  getOutputProgress,
  getDownloadUri,

  // Output Links
  getOutputLinks,
  createOutputLink,
  getOutputLink,
  invalidateOutputLink,

  // Helpers
  buildRtmpUrl,
  setupLiveBroadcast,
  setupRecordingDownload,
  createShareableLink,
  waitForDownloadReady,
}
