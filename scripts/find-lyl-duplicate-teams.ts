import { readFileSync } from 'node:fs'
import { join } from 'node:path'
for (const l of readFileSync(join(__dirname, '..', '.env'), 'utf8').split(
  '\n'
)) {
  const t = l.trim()
  if (!t || t.startsWith('#')) continue
  const eq = t.indexOf('=')
  if (eq < 0) continue
  const k = t.slice(0, eq).trim()
  let v = t.slice(eq + 1).trim()
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  )
    v = v.slice(1, -1)
  if (!(k in process.env)) process.env[k] = v
}
;(async () => {
  const veo = await import('../src/lib/veo/client')
  const tr = await veo.listClubsAndTeams()
  const lyl = tr.data!.clubs.find((c) => c.slug === 'london-youth-league')!
  console.log(`${lyl.teams.length} teams in LYL Veo:\n`)

  // Group by age group (extracted from the name)
  type T = {
    id: string
    name: string
    slug: string
    matchCount: number
    memberCount: number
    stem: string
  }
  const byAge = new Map<string, T[]>()
  for (const team of lyl.teams as any[]) {
    const m = team.name.match(/^(.+?)\s+(U\d{1,2})\b/i)
    if (!m) {
      // No U-suffix → drop into "(other)" bucket
      const arr = byAge.get('(other)') ?? []
      arr.push({
        id: team.id,
        name: team.name,
        slug: team.slug,
        matchCount: team.match_count ?? 0,
        memberCount: team.member_count ?? 0,
        stem: team.name.toLowerCase(),
      })
      byAge.set('(other)', arr)
      continue
    }
    const stem = m[1].toLowerCase().replace(/[.]/g, '').trim()
    const age = m[2].toUpperCase()
    const arr = byAge.get(age) ?? []
    arr.push({
      id: team.id,
      name: team.name,
      slug: team.slug,
      matchCount: team.match_count ?? 0,
      memberCount: team.member_count ?? 0,
      stem,
    })
    byAge.set(age, arr)
  }

  // Within each age, look for collisions: stems where one is a substring of another
  // (TAA / The A Academy don't substring-match, so also use a curated map)
  const KNOWN_ALIASES: Array<[string, string]> = [
    ['taa', 'the a academy'],
    ['london thames', 'london thames fc'],
    ['nsfc', 'n s f c'],
    ['rpt', 'rugby portobello trust'],
  ]
  function namesAlias(a: string, b: string): boolean {
    if (a === b) return true
    if (a.includes(b) || b.includes(a)) return true
    for (const [x, y] of KNOWN_ALIASES) {
      if ((a === x && b === y) || (a === y && b === x)) return true
    }
    return false
  }

  let collisions = 0
  for (const [age, teams] of [...byAge.entries()].sort()) {
    console.log(`=== ${age} (${teams.length} teams) ===`)
    teams.sort((a, b) => a.stem.localeCompare(b.stem))
    // Mark colliding teams
    const collided = new Set<number>()
    for (let i = 0; i < teams.length; i++) {
      for (let j = i + 1; j < teams.length; j++) {
        if (namesAlias(teams[i].stem, teams[j].stem)) {
          collided.add(i)
          collided.add(j)
          collisions++
        }
      }
    }
    for (let i = 0; i < teams.length; i++) {
      const t = teams[i]
      const mark = collided.has(i) ? '⚠️ ' : '   '
      console.log(
        `  ${mark}${t.name.padEnd(28)} slug=${t.slug.padEnd(30)} matches=${t.matchCount} members=${t.memberCount}`
      )
    }
    console.log()
  }
  console.log(`Found ${collisions} potential duplicate pair(s).`)
  const { shutdownVeoSession } = await import('../src/lib/veo/auth')
  await shutdownVeoSession()
})()
