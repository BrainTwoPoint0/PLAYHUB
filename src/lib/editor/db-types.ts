/**
 * Local type shim for the portrait-crop tables.
 *
 * `src/lib/supabase/types.ts` is generated via `supabase gen types` and does
 * not yet include the tables introduced by `20260415_portrait_crop.sql`.
 * Rather than regen the entire 2000+-line file just to land Phase 3, we
 * define the shapes locally and cast the shared supabase client to this
 * narrower Database shape inside the crop routes.
 *
 * When the user runs `npx supabase gen types typescript --linked > src/lib/supabase/types.ts`
 * after the migration is applied, delete this file and import from the
 * regenerated types.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface CropJobRow {
  id: string
  recording_id: string | null
  video_url: string | null
  user_id: string
  status: 'pending' | 'detected' | 'edited' | 'rendered' | 'failed'
  codec_fingerprint: Record<string, unknown> | null
  modal_inference_ms: number | null
  modal_app_version: string | null
  scene_changes: number[]
  output_storage_path: string | null
  error_code: string | null
  error_message: string | null
  created_at: string
  updated_at: string
}

export interface CropKeyframeRow {
  id: string
  job_id: string
  time_seconds: number
  x_pixels: number
  source: 'ai_ball' | 'ai_tracked' | 'ai_cluster' | 'user'
  confidence: number
  edited_by_user: boolean
  edited_at: string | null
  created_at: string
}

export interface FeatureFlagRow {
  key: string
  enabled: boolean
  notes: string | null
  updated_at: string
  updated_by: string | null
}

type Insert<T> = Partial<T> & { [k in keyof T]?: T[k] | null }

export interface CropDatabase {
  public: {
    Tables: {
      playhub_crop_jobs: {
        Row: CropJobRow
        Insert: Insert<CropJobRow>
        Update: Insert<CropJobRow>
      }
      playhub_crop_keyframes: {
        Row: CropKeyframeRow
        Insert: Insert<CropKeyframeRow>
        Update: Insert<CropKeyframeRow>
      }
      playhub_crop_feedback: {
        Row: {
          id: string
          job_id: string
          user_id: string
          action: 'accepted' | 'rejected' | 'edited' | 'exported'
          note: string | null
          keyframes_before: unknown
          keyframes_after: unknown
          created_at: string
        }
        Insert: {
          job_id: string
          user_id: string
          action: string
          note?: string | null
          keyframes_before?: unknown
          keyframes_after?: unknown
        }
        Update: Partial<{
          action: string
          note: string | null
          keyframes_before: unknown
          keyframes_after: unknown
        }>
      }
      playhub_feature_flags: {
        Row: FeatureFlagRow
        Insert: Insert<FeatureFlagRow>
        Update: Insert<FeatureFlagRow>
      }
    }
  }
}

/**
 * Third generic is `any` to satisfy SupabaseClient's internal `GenericSchema`
 * constraint while still letting the `.from(...).select(...)` chain resolve
 * row types from `CropDatabase`. Project eslint (next/core-web-vitals) does
 * not enforce `no-explicit-any`, so no disable comment is needed.
 */
// eslint-disable-next-line
export type CropClient = SupabaseClient<CropDatabase, 'public', any>

/**
 * Narrow the shared supabase client to the crop-tables schema.
 *
 * The shared client is typed against the generated `Database` shape which
 * doesn't yet include the Phase 3 portrait-crop tables. We double-cast via
 * `unknown` to bypass the strict schema-assignability check. Once
 * `npx supabase gen types typescript --linked` is rerun post-migration,
 * delete this module and import the tables from the regenerated types.
 */
// eslint-disable-next-line
export function cropClient(sb: any): CropClient {
  return sb as CropClient
}
