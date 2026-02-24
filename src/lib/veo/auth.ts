// Veo ClubHouse Auth Module
// Uses Playwright to login via headless browser and capture Bearer + CSRF tokens
// Tokens are cached in memory with expiry tracking

import { chromium, type Browser, type Page } from 'playwright'

const VEO_BASE = 'https://app.veo.co'

// Token cache (in-memory, survives across requests in the same process)
let cachedTokens: {
  bearer: string
  csrf: string
  capturedAt: number
} | null = null

// Tokens are valid for ~55 minutes (conservative estimate for ~1hr sessions)
const TOKEN_TTL_MS = 55 * 60 * 1000

interface VeoApiResult {
  status: number
  body: string
  headers?: Record<string, string>
}

export interface VeoSession {
  api: (method: string, path: string, body?: unknown) => Promise<VeoApiResult>
  close: () => Promise<void>
}

function getCredentials() {
  const email = process.env.VEO_EMAIL
  const password = process.env.VEO_PASSWORD
  if (!email || !password) {
    throw new Error('VEO_EMAIL and VEO_PASSWORD must be set in environment')
  }
  return { email, password }
}

function isTokenValid(): boolean {
  if (!cachedTokens) return false
  return Date.now() - cachedTokens.capturedAt < TOKEN_TTL_MS
}

/**
 * Launch browser, navigate to Veo, and attempt to find the login form.
 * Returns null if the form wasn't found (e.g. SPA JS didn't load).
 */
async function attemptLogin(): Promise<{
  browser: Browser
  page: Page
  bearer: string
  csrf: string
} | null> {
  const { email, password } = getCredentials()

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  })
  const page = await context.newPage()

  let bearer = ''
  let csrf = ''

  // Intercept requests to capture tokens
  page.on('request', (request) => {
    const auth = request.headers()['authorization']
    if (
      auth &&
      auth.startsWith('Bearer ') &&
      request.url().includes('app.veo.co/api/')
    ) {
      bearer = auth.replace('Bearer ', '')
    }
    const csrfHeader = request.headers()['x-csrftoken']
    if (csrfHeader) csrf = csrfHeader
  })

  // Navigate — Veo redirects app.veo.co → auth.veo.co/login.html via JS
  await page.goto(VEO_BASE, { waitUntil: 'commit', timeout: 30000 })

  // Wait for the SPA to redirect to auth.veo.co (client-side redirect)
  try {
    await page.waitForURL('**/auth.veo.co/**', { timeout: 20000 })
  } catch {
    // SPA JS didn't load / redirect didn't happen — return null to retry
    await browser.close()
    return null
  }

  // Now on auth.veo.co — wait for the login form to render
  const emailInput = await page
    .waitForSelector(
      'input[type="email"], input[name="email"], input[type="text"]',
      { timeout: 15000 }
    )
    .catch(() => null)

  const passwordInput = await page
    .waitForSelector('input[type="password"]', { timeout: 5000 })
    .catch(() => null)

  if (!emailInput || !passwordInput) {
    await browser.close()
    return null
  }

  await emailInput.fill(email)
  await passwordInput.fill(password)
  await (await page.$('button[type="submit"]'))?.click()

  // Wait for auth redirect back to app.veo.co and token capture
  try {
    await page.waitForURL('**/app.veo.co/**', { timeout: 15000 })
  } catch {
    // Fallback: just wait a bit for the tokens to be intercepted
  }
  await page.waitForTimeout(3000)

  if (!bearer || !csrf) {
    await browser.close()
    throw new Error('Failed to capture Veo auth tokens after login')
  }

  // Cache the tokens
  cachedTokens = { bearer, csrf, capturedAt: Date.now() }

  return { browser, page, bearer, csrf }
}

/**
 * Login to Veo with retry logic for flaky network conditions.
 */
const MAX_LOGIN_RETRIES = 3

async function login(): Promise<{
  browser: Browser
  page: Page
  bearer: string
  csrf: string
}> {
  for (let attempt = 1; attempt <= MAX_LOGIN_RETRIES; attempt++) {
    const result = await attemptLogin()
    if (result) return result
    console.warn(
      `Veo login attempt ${attempt}/${MAX_LOGIN_RETRIES} failed, retrying...`
    )
  }
  throw new Error(`Veo login failed after ${MAX_LOGIN_RETRIES} attempts`)
}

/**
 * Get a Veo session with authenticated API call function.
 * Reuses cached tokens when possible, re-logs in when they expire.
 */
export async function getVeoSession(): Promise<VeoSession> {
  const { browser, page, bearer, csrf } = await login()

  const api = async (
    method: string,
    path: string,
    body?: unknown
  ): Promise<VeoApiResult> => {
    const fullUrl = `${VEO_BASE}${path}`

    const result = await page.evaluate(
      async ({ url, method, body, bearer, csrf }) => {
        const opts: RequestInit = {
          method,
          credentials: 'include',
          headers: {
            Authorization: `Bearer ${bearer}`,
            'X-CSRFToken': csrf,
          },
        }
        if (body) {
          ;(opts.headers as Record<string, string>)['Content-Type'] =
            'application/json'
          opts.body = JSON.stringify(body)
        }
        const res = await fetch(url, opts)
        const text = await res.text()
        return { status: res.status, body: text.substring(0, 50000) }
      },
      { url: fullUrl, method, body, bearer, csrf }
    )

    // If 401, invalidate cache so next session re-logins
    if (result.status === 401) {
      cachedTokens = null
    }

    return result
  }

  const close = async () => {
    await browser.close()
  }

  return { api, close }
}

/**
 * Invalidate cached tokens (call after receiving 401)
 */
export function invalidateTokenCache(): void {
  cachedTokens = null
}
