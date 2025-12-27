// AWS MediaLive Client for PLAYHUB Live Streaming
// Manages channels and inputs for live video streaming

import {
  MediaLiveClient,
  CreateInputCommand,
  CreateChannelCommand,
  DeleteInputCommand,
  DeleteChannelCommand,
  StartChannelCommand,
  StopChannelCommand,
  DescribeChannelCommand,
  DescribeInputCommand,
  ListChannelsCommand,
  ListInputsCommand,
  InputType,
  ChannelState,
  InputClass,
  type CreateInputCommandInput,
  type CreateChannelCommandInput,
  type ChannelSummary,
  type InputDestination,
} from '@aws-sdk/client-medialive'

// ============================================================================
// Types
// ============================================================================

export interface RtmpCredentials {
  url: string
  streamKey: string
  fullUrl: string
}

export interface ChannelInfo {
  id: string
  name: string
  state: ChannelState | string
  inputId: string
  rtmpCredentials?: RtmpCredentials
  playbackUrl?: string
  createdAt?: Date
}

export interface CreateChannelOptions {
  name: string
  streamId: string // PLAYHUB stream ID for tracking
  venueId?: string // Venue that owns this channel
  mediaPackageChannelId?: string
}

// ============================================================================
// Client Configuration
// ============================================================================

const getMediaLiveClient = () => {
  return new MediaLiveClient({
    region: process.env.PLAYHUB_AWS_REGION || 'eu-west-2',
    credentials: {
      accessKeyId: process.env.PLAYHUB_AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.PLAYHUB_AWS_SECRET_ACCESS_KEY!,
    },
  })
}

// ============================================================================
// Input Management
// ============================================================================

/**
 * Create an RTMP push input for receiving streams from cameras/encoders
 */
export async function createRtmpInput(
  name: string,
  streamId: string
): Promise<{
  inputId: string
  rtmpCredentials: RtmpCredentials
}> {
  const client = getMediaLiveClient()

  // Input security group is required for RTMP inputs
  const inputSecurityGroupId = process.env.MEDIALIVE_INPUT_SECURITY_GROUP_ID
  if (!inputSecurityGroupId) {
    throw new Error('MEDIALIVE_INPUT_SECURITY_GROUP_ID environment variable is required')
  }

  const inputParams: CreateInputCommandInput = {
    Name: `playhub-${name}-${streamId}`,
    Type: InputType.RTMP_PUSH,
    InputSecurityGroups: [inputSecurityGroupId],
    Destinations: [
      { StreamName: `stream-${streamId}-primary` },
      { StreamName: `stream-${streamId}-backup` },
    ],
    Tags: {
      Project: 'PLAYHUB',
      StreamId: streamId,
    },
  }

  const response = await client.send(new CreateInputCommand(inputParams))

  if (!response.Input?.Id || !response.Input?.Destinations) {
    throw new Error('Failed to create input - missing ID or destinations')
  }

  // Extract RTMP credentials from the input destinations
  const destination = response.Input.Destinations[0]
  const rtmpCredentials = parseRtmpDestination(destination)

  return {
    inputId: response.Input.Id,
    rtmpCredentials,
  }
}

/**
 * Parse RTMP destination to extract URL and stream key
 */
function parseRtmpDestination(destination: InputDestination): RtmpCredentials {
  // MediaLive provides URL in format: rtmp://[ip]:1935/[app]/[stream]
  const url = destination.Url || ''

  // Split into base URL and stream key
  const lastSlash = url.lastIndexOf('/')
  const baseUrl = url.substring(0, lastSlash)
  const streamKey = url.substring(lastSlash + 1)

  return {
    url: baseUrl,
    streamKey,
    fullUrl: url,
  }
}

/**
 * Get input details including RTMP endpoints
 */
export async function getInput(inputId: string): Promise<{
  id: string
  name: string
  state: string
  rtmpCredentials?: RtmpCredentials
}> {
  const client = getMediaLiveClient()

  const response = await client.send(
    new DescribeInputCommand({ InputId: inputId })
  )

  if (!response.Id) {
    throw new Error('Input not found')
  }

  let rtmpCredentials: RtmpCredentials | undefined
  if (response.Destinations && response.Destinations.length > 0) {
    rtmpCredentials = parseRtmpDestination(response.Destinations[0])
  }

  return {
    id: response.Id,
    name: response.Name || '',
    state: response.State || 'UNKNOWN',
    rtmpCredentials,
  }
}

/**
 * Delete an input
 */
export async function deleteInput(inputId: string): Promise<void> {
  const client = getMediaLiveClient()
  await client.send(new DeleteInputCommand({ InputId: inputId }))
}

// ============================================================================
// Channel Management
// ============================================================================

/**
 * Create a MediaLive channel connected to MediaPackage
 */
export async function createChannel(
  options: CreateChannelOptions
): Promise<ChannelInfo> {
  const client = getMediaLiveClient()

  // First create the input
  const { inputId, rtmpCredentials } = await createRtmpInput(
    options.name,
    options.streamId
  )

  const mediaPackageChannelId =
    options.mediaPackageChannelId ||
    process.env.MEDIAPACKAGE_CHANNEL_ID ||
    'playhub-live-channel'

  const channelParams: CreateChannelCommandInput = {
    Name: `playhub-channel-${options.name}-${options.streamId}`,
    RoleArn: process.env.MEDIALIVE_ROLE_ARN,
    InputAttachments: [
      {
        InputId: inputId,
        InputAttachmentName: 'primary-input',
        InputSettings: {
          SourceEndBehavior: 'CONTINUE',
          InputFilter: 'AUTO',
          FilterStrength: 1,
          DeblockFilter: 'DISABLED',
          DenoiseFilter: 'DISABLED',
        },
      },
    ],
    Destinations: [
      {
        Id: 'mediapackage-destination',
        MediaPackageSettings: [
          {
            ChannelId: mediaPackageChannelId,
          },
        ],
      },
    ],
    EncoderSettings: getEncoderSettings(),
    ChannelClass: 'SINGLE_PIPELINE', // Cost-effective for testing
    Tags: {
      Project: 'PLAYHUB',
      StreamId: options.streamId,
      ...(options.venueId && { VenueId: options.venueId }),
    },
  }

  const response = await client.send(new CreateChannelCommand(channelParams))

  if (!response.Channel?.Id) {
    // Clean up input if channel creation failed
    await deleteInput(inputId)
    throw new Error('Failed to create channel')
  }

  return {
    id: response.Channel.Id,
    name: response.Channel.Name || options.name,
    state: response.Channel.State || 'CREATING',
    inputId,
    rtmpCredentials,
    playbackUrl: process.env.MEDIAPACKAGE_HLS_URL,
  }
}

/**
 * Get encoder settings for 720p streaming
 */
function getEncoderSettings() {
  return {
    AudioDescriptions: [
      {
        AudioSelectorName: 'default',
        Name: 'audio_1',
        CodecSettings: {
          AacSettings: {
            Bitrate: 128000,
            CodingMode: 'CODING_MODE_2_0' as const,
            InputType: 'NORMAL' as const,
            Profile: 'LC' as const,
            RateControlMode: 'CBR' as const,
            RawFormat: 'NONE' as const,
            SampleRate: 48000,
            Spec: 'MPEG4' as const,
          },
        },
      },
    ],
    VideoDescriptions: [
      {
        Name: 'video_720p',
        Width: 1280,
        Height: 720,
        CodecSettings: {
          H264Settings: {
            Bitrate: 3000000,
            FramerateControl: 'SPECIFIED' as const,
            FramerateNumerator: 30,
            FramerateDenominator: 1,
            GopSize: 2,
            GopSizeUnits: 'SECONDS' as const,
            Level: 'H264_LEVEL_AUTO' as const,
            Profile: 'HIGH' as const,
            RateControlMode: 'CBR' as const,
            ScanType: 'PROGRESSIVE' as const,
            // Required for MediaPackage output - use square pixels (1:1)
            ParControl: 'SPECIFIED' as const,
            ParNumerator: 1,
            ParDenominator: 1,
          },
        },
      },
    ],
    OutputGroups: [
      {
        Name: 'MediaPackage',
        OutputGroupSettings: {
          MediaPackageGroupSettings: {
            Destination: {
              DestinationRefId: 'mediapackage-destination',
            },
          },
        },
        Outputs: [
          {
            OutputName: '720p',
            VideoDescriptionName: 'video_720p',
            AudioDescriptionNames: ['audio_1'],
            OutputSettings: {
              MediaPackageOutputSettings: {},
            },
          },
        ],
      },
    ],
    TimecodeConfig: {
      Source: 'SYSTEMCLOCK' as const,
    },
  }
}

/**
 * Start a channel (begins billing)
 */
export async function startChannel(channelId: string): Promise<void> {
  const client = getMediaLiveClient()
  await client.send(new StartChannelCommand({ ChannelId: channelId }))
}

/**
 * Stop a channel (stops billing)
 */
export async function stopChannel(channelId: string): Promise<void> {
  const client = getMediaLiveClient()
  await client.send(new StopChannelCommand({ ChannelId: channelId }))
}

/**
 * Get channel details
 */
export async function getChannel(channelId: string): Promise<ChannelInfo> {
  const client = getMediaLiveClient()

  const response = await client.send(
    new DescribeChannelCommand({ ChannelId: channelId })
  )

  if (!response.Id) {
    throw new Error('Channel not found')
  }

  // Get input details for RTMP credentials
  let rtmpCredentials: RtmpCredentials | undefined
  const inputId = response.InputAttachments?.[0]?.InputId
  if (inputId) {
    const input = await getInput(inputId)
    rtmpCredentials = input.rtmpCredentials
  }

  return {
    id: response.Id,
    name: response.Name || '',
    state: response.State || 'UNKNOWN',
    inputId: inputId || '',
    rtmpCredentials,
    playbackUrl: process.env.MEDIAPACKAGE_HLS_URL,
  }
}

/**
 * Delete a channel and its input
 */
export async function deleteChannel(channelId: string): Promise<void> {
  const client = getMediaLiveClient()

  // Get channel to find input ID
  const channel = await getChannel(channelId)

  // Stop channel if running
  if (channel.state === 'RUNNING') {
    await stopChannel(channelId)
    // Wait for channel to stop
    await waitForChannelState(channelId, 'IDLE')
  }

  // Delete channel
  await client.send(new DeleteChannelCommand({ ChannelId: channelId }))

  // Wait for channel to be deleted before deleting input
  await waitForChannelDeleted(channelId)

  // Delete input
  if (channel.inputId) {
    await deleteInput(channel.inputId)
  }
}

/**
 * Wait for channel to reach a specific state
 */
async function waitForChannelState(
  channelId: string,
  targetState: string,
  timeoutMs: number = 300000
): Promise<void> {
  const startTime = Date.now()
  const pollInterval = 5000

  while (Date.now() - startTime < timeoutMs) {
    const channel = await getChannel(channelId)
    if (channel.state === targetState) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval))
  }

  throw new Error(`Timeout waiting for channel to reach state: ${targetState}`)
}

/**
 * Wait for channel to be deleted
 */
async function waitForChannelDeleted(
  channelId: string,
  timeoutMs: number = 300000
): Promise<void> {
  const startTime = Date.now()
  const pollInterval = 5000
  const client = getMediaLiveClient()

  while (Date.now() - startTime < timeoutMs) {
    try {
      await client.send(new DescribeChannelCommand({ ChannelId: channelId }))
      // Channel still exists, wait and try again
      await new Promise((resolve) => setTimeout(resolve, pollInterval))
    } catch (error: any) {
      if (error.name === 'NotFoundException') {
        return // Channel is deleted
      }
      throw error
    }
  }

  throw new Error('Timeout waiting for channel to be deleted')
}

/**
 * List all PLAYHUB channels
 */
export async function listChannels(): Promise<ChannelSummary[]> {
  const client = getMediaLiveClient()

  const response = await client.send(new ListChannelsCommand({}))

  // Filter to only PLAYHUB channels
  return (response.Channels || []).filter(
    (channel) =>
      channel.Name?.startsWith('playhub-') ||
      channel.Tags?.Project === 'PLAYHUB'
  )
}

// ============================================================================
// Export Client Object
// ============================================================================

export const mediaLiveClient = {
  // Input management
  createRtmpInput,
  getInput,
  deleteInput,

  // Channel management
  createChannel,
  startChannel,
  stopChannel,
  getChannel,
  deleteChannel,
  listChannels,

  // Utilities
  waitForChannelState,
}
