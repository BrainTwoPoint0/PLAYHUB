// TikTok Display API reads for PLAYHUB — profile, aggregate stats, and video list.
// Covers scopes: user.info.profile, user.info.stats, video.list.
// Field names verified against:
//   https://developers.tiktok.com/doc/tiktok-api-v2-get-user-info
//   https://developers.tiktok.com/doc/tiktok-api-v2-video-list

import { tiktok } from './client'

const USER_INFO_URL = 'https://open.tiktokapis.com/v2/user/info/'
const VIDEO_LIST_URL = 'https://open.tiktokapis.com/v2/video/list/'

// Fields requested from user/info. avatar_url + display_name = user.info.profile;
// the *_count fields = user.info.stats.
const USER_FIELDS = [
  'open_id',
  'union_id',
  'avatar_url',
  'display_name',
  'follower_count',
  'following_count',
  'likes_count',
  'video_count',
].join(',')

// Fields requested per video (video.list).
const VIDEO_FIELDS = [
  'id',
  'title',
  'cover_image_url',
  'share_url',
  'view_count',
  'like_count',
  'comment_count',
  'share_count',
  'create_time',
].join(',')

export interface TikTokProfile {
  openId: string
  unionId: string | null
  avatarUrl: string | null
  displayName: string | null
  followerCount: number
  followingCount: number
  likesCount: number
  videoCount: number
}

export interface TikTokVideo {
  id: string
  title: string
  coverImageUrl: string | null
  shareUrl: string | null
  viewCount: number
  likeCount: number
  commentCount: number
  shareCount: number
  createTime: number
}

export interface TikTokVideoPage {
  videos: TikTokVideo[]
  cursor: number
  hasMore: boolean
}

interface TikTokError {
  code?: string
  message?: string
  log_id?: string
}

/** Throw on the `error` envelope TikTok returns even with HTTP 200. */
function assertOk(error: TikTokError | undefined, httpStatus: number): void {
  if (httpStatus < 200 || httpStatus >= 300) {
    throw new Error(
      `TikTok API HTTP ${httpStatus}${error?.message ? `: ${error.message}` : ''}`
    )
  }
  if (error && error.code && error.code !== 'ok') {
    throw new Error(`TikTok API error (${error.code}): ${error.message ?? ''}`)
  }
}

/** Fetch the connected account's profile + aggregate stats. */
export async function getUserInfo(userId: string): Promise<TikTokProfile> {
  const token = await tiktok.getAccessToken(userId)
  const res = await fetch(`${USER_INFO_URL}?fields=${USER_FIELDS}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const json = (await res.json()) as {
    data?: { user?: Record<string, unknown> }
    error?: TikTokError
  }
  assertOk(json.error, res.status)
  const u = json.data?.user ?? {}
  return {
    openId: String(u.open_id ?? ''),
    unionId: (u.union_id as string) ?? null,
    avatarUrl: (u.avatar_url as string) ?? null,
    displayName: (u.display_name as string) ?? null,
    followerCount: Number(u.follower_count ?? 0),
    followingCount: Number(u.following_count ?? 0),
    likesCount: Number(u.likes_count ?? 0),
    videoCount: Number(u.video_count ?? 0),
  }
}

/** List the connected account's videos with per-video metrics. */
export async function listVideos(
  userId: string,
  cursor?: number,
  maxCount = 20
): Promise<TikTokVideoPage> {
  const token = await tiktok.getAccessToken(userId)
  const body: Record<string, unknown> = { max_count: maxCount }
  if (typeof cursor === 'number') body.cursor = cursor

  const res = await fetch(`${VIDEO_LIST_URL}?fields=${VIDEO_FIELDS}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const json = (await res.json()) as {
    data?: {
      videos?: Array<Record<string, unknown>>
      cursor?: number
      has_more?: boolean
    }
    error?: TikTokError
  }
  assertOk(json.error, res.status)

  const videos = (json.data?.videos ?? []).map((v) => ({
    id: String(v.id ?? ''),
    title: String(v.title ?? ''),
    coverImageUrl: (v.cover_image_url as string) ?? null,
    shareUrl: (v.share_url as string) ?? null,
    viewCount: Number(v.view_count ?? 0),
    likeCount: Number(v.like_count ?? 0),
    commentCount: Number(v.comment_count ?? 0),
    shareCount: Number(v.share_count ?? 0),
    createTime: Number(v.create_time ?? 0),
  }))

  return {
    videos,
    cursor: Number(json.data?.cursor ?? 0),
    hasMore: !!json.data?.has_more,
  }
}
