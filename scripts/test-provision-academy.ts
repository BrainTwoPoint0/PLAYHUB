#!/usr/bin/env tsx
// Manual one-shot validation for the academy provisioning path.
//
// Purpose: prove that the Veo invite call from provision.ts works against the
// live Veo cluster before Checkpoint B2 wires the call into the Stripe webhook.
// If this script fails, the webhook path will fail too — fix here first.
//
// Usage (Veo-only, fastest sanity check):
//
//   cd PLAYHUB && npx tsx scripts/test-provision-academy.ts \
//     --veo-club-slug=playback-15fdc44b \
//     --veo-team-slug=<a real CFA team slug> \
//     --email=karim+veo-test-$(date +%s)@playbacksports.ai
//
// Usage (full provision.ts pipeline against an existing row in
// playhub_academy_subscriptions; useful after B2 to verify a real subscription
// can be re-provisioned manually):
//
//   cd PLAYHUB && npx tsx scripts/test-provision-academy.ts --row-id=<uuid>
//
// Required env: STRIPE_SECRET_KEY, NEXT_PUBLIC_SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, plus whatever the Veo client lib needs.

import 'dotenv/config'
import { invitePlayer } from '@/lib/veo/client'
import { provisionAcademyAccess } from '@/lib/academy/provision'

interface Args {
  rowId?: string
  veoClubSlug?: string
  veoTeamSlug?: string
  email?: string
}

function parseArgs(argv: string[]): Args {
  const out: Args = {}
  for (const arg of argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.+)$/)
    if (!m) continue
    const [, key, val] = m
    switch (key) {
      case 'row-id':
        out.rowId = val
        break
      case 'veo-club-slug':
        out.veoClubSlug = val
        break
      case 'veo-team-slug':
        out.veoTeamSlug = val
        break
      case 'email':
        out.email = val
        break
    }
  }
  return out
}

async function veoOnly(args: Args): Promise<number> {
  if (!args.veoClubSlug || !args.veoTeamSlug || !args.email) {
    console.error(
      '--veo-only mode needs --veo-club-slug, --veo-team-slug, --email'
    )
    return 2
  }
  console.log(
    `Inviting ${args.email} to ${args.veoClubSlug}/${args.veoTeamSlug} ...`
  )
  const result = await invitePlayer(
    args.veoClubSlug,
    args.veoTeamSlug,
    args.email
  )
  console.log('Result:', JSON.stringify(result, null, 2))
  return result.success ? 0 : 1
}

async function fullPipeline(rowId: string): Promise<number> {
  console.log(`Running provisionAcademyAccess against row ${rowId} ...`)
  const outcome = await provisionAcademyAccess(rowId)
  console.log('Outcome:', JSON.stringify(outcome, null, 2))
  return outcome.kind === 'success' ? 0 : 1
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv)

  if (args.rowId) {
    return fullPipeline(args.rowId)
  }
  if (args.veoClubSlug || args.veoTeamSlug || args.email) {
    return veoOnly(args)
  }

  console.error(
    'No mode selected. Pass either --row-id=<uuid> for the full provision.ts pipeline,\n' +
      'or --veo-club-slug=... --veo-team-slug=... --email=... to test the Veo invite alone.'
  )
  return 2
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
