// Veo ClubHouse scraper for AWS Lambda
// Uses playwright-core + @sparticuz/chromium instead of full playwright
// Adapted from src/lib/veo/auth.ts and src/lib/veo/client.ts

import { chromium, type Browser, type Page } from 'playwright-core'
import sparticuzChromium from '@sparticuz/chromium'

const VEO_BASE = 'https://app.veo.co'
const MAX_LOGIN_RETRIES = 3

// ============================================================================
// Types
// ============================================================================

interface VeoApiResult {
  status: number
  body: string
}

export interface VeoSession {
  api: (method: string, path: string, body?: unknown) => Promise<VeoApiResult>
  close: () => Promise<void>
}

export interface VeoTeam {
  id: string
  slug: string
  name: string
  member_count: number
}

export interface VeoMember {
  id: string
  email: string
  name: string
  status: string
  permission_role: string
}

export interface VeoRecording {
  slug: string
  title: string
  privacy: string
  team: string
}

// ============================================================================
// Auth: login to Veo via headless Chromium
// ============================================================================

function getCredentials() {
  const email = process.env.VEO_EMAIL
  const password = process.env.VEO_PASSWORD
  if (!email || !password) {
    throw new Error('VEO_EMAIL and VEO_PASSWORD must be set in environment')
  }
  return { email, password }
}

async function attemptLogin(): Promise<{
  browser: Browser
  page: Page
  bearer: string
  csrf: string
} | null> {
  const { email, password } = getCredentials()

  const browser = await chromium.launch({
    args: sparticuzChromium.args,
    executablePath: await sparticuzChromium.executablePath(),
    headless: true,
  })
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
    console.warn(
      `Token capture failed (bearer: ${bearer ? 'yes' : 'no'}, csrf: ${csrf ? 'yes' : 'no'})`
    )
    await browser.close()
    return null
  }

  return { browser, page, bearer, csrf }
}

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

// ============================================================================
// Session: authenticated API calls via page.evaluate()
// ============================================================================

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
        return { status: res.status, body: text.substring(0, 500000) }
      },
      { url: fullUrl, method, body, bearer, csrf }
    )

    return result
  }

  const close = async () => {
    await browser.close()
  }

  return { api, close }
}

// ============================================================================
// Scraping: list all teams + members for a club (single session)
// ============================================================================

function parseBody(body: string): any {
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

export async function listClubTeamsWithMembers(
  session: VeoSession,
  clubSlug: string
): Promise<{
  clubName: string
  teams: (VeoTeam & { members: VeoMember[] })[]
}> {
  // Fetch teams
  const teamsRes = await session.api('GET', `/api/app/clubs/${clubSlug}/teams/`)

  if (teamsRes.status !== 200) {
    throw new Error(`Failed to list teams: HTTP ${teamsRes.status}`)
  }

  const teams: VeoTeam[] = parseBody(teamsRes.body) || []
  const result: (VeoTeam & { members: VeoMember[] })[] = []

  // Fetch members for each team within the same session
  for (const team of teams) {
    const membersRes = await session.api(
      'GET',
      `/api/app/clubs/${clubSlug}/teams/${team.slug}/members/?status=active&page_size=500`
    )
    const members: VeoMember[] =
      membersRes.status === 200 ? parseBody(membersRes.body) || [] : []
    result.push({ ...team, members })
  }

  return { clubName: clubSlug, teams: result }
}

// ============================================================================
// Privacy sync: list club recordings, set privacy
// ============================================================================

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function listClubRecordings(
  session: VeoSession,
  clubSlug: string
): Promise<VeoRecording[]> {
  const allRecordings: VeoRecording[] = []
  let page = 1

  while (true) {
    const res = await session.api(
      'GET',
      `/api/app/clubs/${clubSlug}/recordings/?filter=own&page_size=100&page=${page}`
    )

    if (res.status !== 200) {
      throw new Error(
        `Failed to list recordings for ${clubSlug}: HTTP ${res.status}`
      )
    }

    const parsed = parseBody(res.body)
    if (!parsed) break

    // Handle paginated { count, next, results: [...] } or plain array
    const items: VeoRecording[] = Array.isArray(parsed)
      ? parsed
      : parsed?.results || []

    allRecordings.push(...items)
    console.log(
      `Page ${page}: ${items.length} recordings (total: ${allRecordings.length})`
    )

    // Stop if fewer than page_size results (last page)
    if (items.length < 100) break

    // For paginated objects, also check the next field
    if (!Array.isArray(parsed) && !parsed?.next) break

    await sleep(2000)
    page++
  }

  return allRecordings
}

export async function setMatchPrivacy(
  session: VeoSession,
  matchSlug: string,
  privacy: string
): Promise<{ status: number }> {
  const res = await session.api('PATCH', `/api/app/matches/${matchSlug}/`, {
    privacy,
  })
  return { status: res.status }
}
