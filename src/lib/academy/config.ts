// Academy club configuration
// Maps club slugs to Stripe product IDs for subscription tracking

export interface AcademyClub {
  slug: string
  name: string
  stripeProductId: string
  additionalStripeProductIds?: string[] // Extra products sharing the same Veo club
  veoClubSlug?: string
  organizationId?: string
  logoUrl?: string | null
}

export const ACADEMY_CLUBS: Record<string, AcademyClub> = {
  cfa: {
    slug: 'cfa',
    name: 'PLAYBACK Academy - CFA',
    stripeProductId: 'prod_RWhRQ4wM3PiEBJ',
    veoClubSlug: 'playback-15fdc44b',
  },
  sefa: {
    slug: 'sefa',
    name: 'PLAYBACK Academy - SEFA',
    stripeProductId: 'prod_QiMBPC4wf4nff1',
    additionalStripeProductIds: [
      'prod_Qyv9ID1M0sCowi', // Maidstone United
      'prod_QuA6axz11zTGbw', // Hollands & Blair
    ],
    veoClubSlug: 'soccer-elite-fa-0b0814d2',
  },
}

export function getClubBySlug(slug: string): AcademyClub | undefined {
  return ACADEMY_CLUBS[slug]
}

export function getAllClubs(): AcademyClub[] {
  return Object.values(ACADEMY_CLUBS)
}

/** Returns all Stripe product IDs for a club (primary + additional) */
export function getAllProductIds(club: AcademyClub): string[] {
  return [club.stripeProductId, ...(club.additionalStripeProductIds || [])]
}
