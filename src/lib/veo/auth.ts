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

// Cached LIVE session (browser + page kept open) so repeated
// withSession() calls reuse one Playwright instance instead of launching
// a fresh browser per request. Without this, scripts that make N API
// calls hit Veo's rate limits / lose token capture between launches.
//
// The cached session's `close()` is a no-op for reuse; real teardown
// happens via `shutdownVeoSession()` from a top-level finally.
let cachedSession: {
  browser: Browser
  page: Page
  api: VeoSession['api']
  apiMultipart: VeoSession['apiMultipart']
} | null = null

interface VeoApiResult {
  status: number
  body: string
  headers?: Record<string, string>
}

export interface VeoMultipartPart {
  /** Form field name (e.g. 'crest' for team logo upload). */
  name: string
  /** Filename to send with the part (browser uses original; we use a sensible default). */
  filename: string
  /** Image / file MIME type (e.g. 'image/png', 'image/webp'). */
  mimeType: string
  /** Raw bytes. */
  buffer: Buffer
}

export interface VeoSession {
  api: (method: string, path: string, body?: unknown) => Promise<VeoApiResult>
  /** Multipart variant for file uploads (team crest, club crest, etc).
   *  Builds a FormData object inside the browser context so we inherit the
   *  same cookies / origin / referer as the cached page. */
  apiMultipart: (
    method: string,
    path: string,
    parts: VeoMultipartPart[]
  ) => Promise<VeoApiResult>
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
 * Build the chromium.launch() options object — Lambda-aware.
 *
 * In a Lambda (AWS_LAMBDA_FUNCTION_NAME set), the `@sparticuz/chromium`
 * layer provides the chromium binary at a fixed path under /opt; we
 * pass its executablePath + the layer's recommended args. Outside Lambda
 * (local dev, scripts), fall through to playwright's bundled chromium.
 *
 * Dynamic import on purpose: `@sparticuz/chromium` is a Lambda-layer
 * dep, NOT a Next.js runtime dep. A top-level static import would force
 * Netlify's `next build` to resolve it (and fail), so we gate the
 * import behind the runtime check.
 */
async function buildLaunchOpts(): Promise<
  Parameters<typeof chromium.launch>[0]
> {
  if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return { headless: true }
  }
  // Lambda path — load the sparticuz layer's binary + args.
  //
  // Indirection via `new Function('return import(...)')` hides the
  // import specifier from webpack's static analysis. Without this,
  // Next.js's build fails with `Module not found: Can't resolve
  // '@sparticuz/chromium'` because the package is only installed in
  // the Lambda bundle (infrastructure/lambda/veo-sync/) not in
  // PLAYHUB's root deps. The Function-constructed import is evaluated
  // at runtime by V8, not at build time by webpack.
  const dynamicImport = new Function('m', 'return import(m)') as (
    m: string
  ) => Promise<unknown>
  const mod = (await dynamicImport('@sparticuz/chromium')) as {
    default?: unknown
  }
  const sparticuz = mod.default ?? mod
  // Narrow the shape so TypeScript doesn't complain (we know what
  // sparticuz exports — args is a string[], executablePath() is async).
  const sp = sparticuz as {
    args: string[]
    headless?: boolean
    executablePath: () => Promise<string>
  }
  return {
    args: sp.args,
    headless: true,
    executablePath: await sp.executablePath(),
  }
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

  const browser = await chromium.launch(await buildLaunchOpts())
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

  // CSRF fallback: if the request interceptor never saw an X-CSRFToken
  // header (because the SPA only fired GETs in the wait window), read
  // the `csrftoken` cookie directly. Django sets this immediately at
  // login; the SPA reads it from cookies and reflects it back as the
  // X-CSRFToken header on writes. Without this fallback the Lambda
  // login fails ~100% of the time because the post-login dashboard
  // only loads GET endpoints during the 3s capture window. Pattern
  // already in use by the veo-sync Lambda's scraper.
  if (!csrf) {
    const cookies = await context.cookies()
    const csrfCookie = cookies.find(
      (c) => c.name === 'csrftoken' || c.name === 'csrf_token'
    )
    if (csrfCookie) csrf = csrfCookie.value
  }

  if (!bearer || !csrf) {
    console.warn(
      `Veo token capture failed (bearer: ${bearer ? 'yes' : 'no'}, csrf: ${csrf ? 'yes' : 'no'})`
    )
    await browser.close()
    // Return null instead of throwing so the outer login() retry loop
    // can try again — matches the form-not-found path's behaviour.
    return null
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
 *
 * Session reuse: if we have an open browser + page from a previous call
 * AND the cached tokens are still within their TTL, reuse that session
 * — closing/relaunching the browser for every API call hits Veo's rate
 * limits AND fails token capture intermittently. The session's close()
 * is wired as a NO-OP so callers using withSession() don't accidentally
 * tear down a session another withSession() will need next.
 *
 * Explicit teardown: call shutdownVeoSession() from a top-level finally
 * once all API work is done. Scripts that exit immediately can rely on
 * process exit to clean up.
 */
export async function getVeoSession(): Promise<VeoSession> {
  if (cachedSession && isTokenValid()) {
    return {
      api: cachedSession.api,
      apiMultipart: cachedSession.apiMultipart,
      close: async () => {
        /* no-op: cached session lifetime is managed by shutdownVeoSession() */
      },
    }
  }
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
        // 5MB cap. Was 50KB which silently truncated mid-JSON for large
        // listing responses (e.g. LYL's 35-team listing serialises to
        // ~70KB once Veo adds permission objects + speed_zones to each
        // team), making parseBody return null and downstream code think
        // the listing was empty. 5MB is well above any realistic
        // listing payload and still bounded.
        return { status: res.status, body: text.substring(0, 5_000_000) }
      },
      { url: fullUrl, method, body, bearer, csrf }
    )

    // If 401, invalidate cache so next session re-logins. Also tear
    // down the cached browser since its tokens are stale — leaving it
    // open would keep returning 401 forever.
    if (result.status === 401) {
      cachedTokens = null
      if (cachedSession) {
        const stale = cachedSession
        cachedSession = null
        await stale.browser.close().catch(() => {})
      }
    }

    return result
  }

  const apiMultipart = async (
    method: string,
    path: string,
    parts: VeoMultipartPart[]
  ): Promise<VeoApiResult> => {
    const fullUrl = `${VEO_BASE}${path}`
    // Reject anything weird at the call boundary — these payloads ship to
    // a third-party API, and a malformed buffer / missing mime type would
    // either 400 silently or upload an unviewable asset.
    if (!parts.length)
      throw new Error('apiMultipart: at least one part required')
    for (const p of parts) {
      if (!p.name || !p.filename || !p.mimeType || !Buffer.isBuffer(p.buffer)) {
        throw new Error(
          `apiMultipart: malformed part "${p.name}" — name/filename/mimeType/buffer all required`
        )
      }
      if (p.buffer.length === 0) {
        throw new Error(`apiMultipart: part "${p.name}" buffer is empty`)
      }
      // 5MB cap. Above this the `Array.from(buffer)` serialisation into
      // page.evaluate (~4× expansion) blows past Lambda's default 512MB
      // heap during the IPC hop. Operator scripts must compress upstream.
      // When this graduates to Lambda, switch to page.context().request.post()
      // which streams via CDP binary channel instead of through V8 strings.
      if (p.buffer.length > 5_000_000) {
        throw new Error(
          `apiMultipart: part "${p.name}" exceeds 5MB cap (${p.buffer.length} bytes)`
        )
      }
    }

    // Serialise parts as plain objects so they survive page.evaluate's
    // structured clone. Buffers cross as plain numeric arrays — fine for
    // the small images (<5MB) we upload here; if we ever need to upload
    // larger payloads we should switch to page.context().request.post()
    // (Playwright's APIRequestContext has first-class multipart support
    // and shares cookies, but doesn't share the JS context bearer/csrf).
    const serialisableParts = parts.map((p) => ({
      name: p.name,
      filename: p.filename,
      mimeType: p.mimeType,
      bytes: Array.from(p.buffer),
    }))

    const result = await page.evaluate(
      async ({ url, method, parts, bearer, csrf }) => {
        const fd = new FormData()
        for (const part of parts) {
          const blob = new Blob([new Uint8Array(part.bytes)], {
            type: part.mimeType,
          })
          fd.append(part.name, blob, part.filename)
        }
        // NOTE: do NOT set Content-Type — the browser must set it so the
        // boundary is included. Setting it manually breaks the upload.
        const res = await fetch(url, {
          method,
          credentials: 'include',
          headers: {
            Authorization: `Bearer ${bearer}`,
            'X-CSRFToken': csrf,
          },
          body: fd,
        })
        const text = await res.text()
        return { status: res.status, body: text.substring(0, 5_000_000) }
      },
      { url: fullUrl, method, parts: serialisableParts, bearer, csrf }
    )

    if (result.status === 401) {
      cachedTokens = null
      if (cachedSession) {
        const stale = cachedSession
        cachedSession = null
        await stale.browser.close().catch(() => {})
      }
    }

    return result
  }

  // Stash the live session for reuse — every subsequent withSession()
  // call will hit the early-return path above instead of relaunching.
  cachedSession = { browser, page, api, apiMultipart }

  return {
    api,
    apiMultipart,
    close: async () => {
      /* no-op: caller should use shutdownVeoSession() to free the browser */
    },
  }
}

/**
 * Invalidate cached tokens (call after receiving 401)
 */
export function invalidateTokenCache(): void {
  cachedTokens = null
}

/**
 * Explicit teardown for the cached browser session. Long-running scripts
 * should call this in a top-level finally so the Playwright process is
 * cleaned up; one-shot scripts can rely on process exit instead.
 */
export async function shutdownVeoSession(): Promise<void> {
  if (!cachedSession) return
  const stale = cachedSession
  cachedSession = null
  try {
    await stale.browser.close()
  } catch {
    /* best-effort */
  }
}
