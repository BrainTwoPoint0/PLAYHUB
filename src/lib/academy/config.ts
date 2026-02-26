// Academy club configuration
// Fetches from playhub_academy_config table with 5-min in-memory cache

import { createServiceClient } from '@/lib/supabase/server'

export interface AcademyClub {
  slug: string
  name: string
  stripeProductId: string
  additionalStripeProductIds?: string[]
  veoClubSlug?: string
  organizationId?: string
  logoUrl?: string | null
}

// ============================================================================
// Cache (5-minute TTL, same pattern as stripe.ts)
// ============================================================================

let cachedClubs: AcademyClub[] | null = null
let cacheExpiresAt = 0
const CACHE_TTL_MS = 5 * 60 * 1000

async function loadClubs(): Promise<AcademyClub[]> {
  if (cachedClubs && Date.now() < cacheExpiresAt) {
    return cachedClubs
  }

  const supabase = createServiceClient() as any
  const { data, error } = await supabase
    .from('playhub_academy_config')
    .select('*')
    .eq('is_active', true)
    .order('club_slug')

  if (error) throw new Error(`Failed to load academy config: ${error.message}`)

  cachedClubs = (data || []).map((row: any) => ({
    slug: row.club_slug,
    name: row.name,
    stripeProductId: row.stripe_product_id,
    additionalStripeProductIds: row.additional_stripe_product_ids?.length
      ? row.additional_stripe_product_ids
      : undefined,
    veoClubSlug: row.veo_club_slug || undefined,
    organizationId: row.organization_id || undefined,
    logoUrl: row.logo_url || null,
  }))
  cacheExpiresAt = Date.now() + CACHE_TTL_MS

  return cachedClubs!
}

// Exported for testing
export function clearConfigCache(): void {
  cachedClubs = null
  cacheExpiresAt = 0
}

// ============================================================================
// Public API
// ============================================================================

export async function getClubBySlug(
  slug: string
): Promise<AcademyClub | undefined> {
  const clubs = await loadClubs()
  return clubs.find((c) => c.slug === slug)
}

export async function getAllClubs(): Promise<AcademyClub[]> {
  return loadClubs()
}

/** Returns all Stripe product IDs for a club (primary + additional) — sync, no DB call */
export function getAllProductIds(club: AcademyClub): string[] {
  return [club.stripeProductId, ...(club.additionalStripeProductIds || [])]
}
