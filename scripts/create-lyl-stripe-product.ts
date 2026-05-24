/**
 * One-shot creator for the LYL pilot Stripe Product + Price.
 *
 * Creates a single Product ("LYL Academy Subscription") with a single
 * recurring monthly Price (£15/month). The existing checkout flow picks
 * the first active recurring price on the product, so changing the price
 * later in the Stripe dashboard requires no code change.
 *
 * Idempotent: if a product with the same name already exists in this
 * Stripe account, this script reuses it rather than minting a duplicate.
 * Same posture for the price (matches on amount + currency + interval +
 * product). Re-running prints the existing IDs.
 *
 * Usage:
 *   cd PLAYHUB && npx tsx scripts/create-lyl-stripe-product.ts
 *
 * Env required (loaded from .env):
 *   STRIPE_SECRET_KEY
 */

import Stripe from 'stripe'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Inline .env loader — dotenv isn't a runtime dep on PLAYHUB and I don't
// want to touch the lockfile for a one-shot script. Parses simple
// `KEY=VALUE` lines, ignores comments + blank lines, strips surrounding
// quotes. Doesn't override values already set in process.env.
function loadEnvFile(path: string): void {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return // silent if .env is absent — caller falls back to process.env
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}

loadEnvFile(join(__dirname, '..', '.env'))

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY
if (!STRIPE_KEY) {
  throw new Error('Missing STRIPE_SECRET_KEY in PLAYHUB/.env')
}

const stripe = new Stripe(STRIPE_KEY, { apiVersion: '2025-02-24.acacia' })

const PRODUCT_NAME = 'LYL Academy Subscription'
const PRODUCT_DESCRIPTION =
  'Monthly subscription to a London Youth League academy team. Unlocks match recordings, training clips, and analysis from every fixture.'
const PRICE_AMOUNT_PENCE = 1500 // £15.00
const PRICE_CURRENCY = 'gbp'
const PRICE_INTERVAL: Stripe.PriceCreateParams.Recurring.Interval = 'month'

async function findOrCreateProduct(): Promise<Stripe.Product> {
  // Search the account for an existing product with the same name. The
  // products.search API would be cleaner but requires search-enabled
  // accounts — list+filter is more portable for a one-shot script.
  for await (const product of stripe.products.list({
    limit: 100,
    active: true,
  })) {
    if (product.name === PRODUCT_NAME) {
      console.log(
        `Found existing product ${product.id} matching "${PRODUCT_NAME}"`
      )
      return product
    }
  }
  console.log(`Creating new product "${PRODUCT_NAME}"…`)
  return stripe.products.create({
    name: PRODUCT_NAME,
    description: PRODUCT_DESCRIPTION,
    metadata: {
      type: 'academy_subscription',
      club_slug: 'lyl',
    },
  })
}

async function findOrCreatePrice(productId: string): Promise<Stripe.Price> {
  // Reuse a matching active recurring price if one exists.
  for await (const price of stripe.prices.list({
    product: productId,
    active: true,
    limit: 100,
  })) {
    if (
      price.unit_amount === PRICE_AMOUNT_PENCE &&
      price.currency === PRICE_CURRENCY &&
      price.recurring?.interval === PRICE_INTERVAL &&
      price.type === 'recurring'
    ) {
      console.log(
        `Found existing price ${price.id} (${(price.unit_amount! / 100).toFixed(2)} ${price.currency.toUpperCase()}/${price.recurring!.interval})`
      )
      return price
    }
  }
  console.log(
    `Creating new price ${(PRICE_AMOUNT_PENCE / 100).toFixed(2)} ${PRICE_CURRENCY.toUpperCase()}/${PRICE_INTERVAL}…`
  )
  return stripe.prices.create({
    product: productId,
    unit_amount: PRICE_AMOUNT_PENCE,
    currency: PRICE_CURRENCY,
    recurring: { interval: PRICE_INTERVAL },
  })
}

async function main() {
  const product = await findOrCreateProduct()
  const price = await findOrCreatePrice(product.id)

  console.log('\n--- Stripe IDs (paste into seed SQL) ---\n')
  console.log(`stripe_product_id: '${product.id}'`)
  console.log(`stripe_price_id  : '${price.id}'`)
  console.log(`display_price    : '£15/month'`)
  console.log()
  console.log(
    `Stripe dashboard: https://dashboard.stripe.com/products/${product.id}`
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
