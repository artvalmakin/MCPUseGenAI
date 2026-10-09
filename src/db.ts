// Read-only client for the Supabase REST API (PostgREST): only GET requests to the `cases` table.

const SUPABASE_URL = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '')
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? ''

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_KEY must be set')
}

const PAGE_SIZE = 1000

export interface CaseSummary {
  id: string
  title: string | null
  company: string | null
  industry: string | null
  business_function: string | null
  published_at: string | null
}

const SUMMARY_COLUMNS = 'id,title,company,industry,business_function,published_at'
const SEARCH_COLUMNS = `${SUMMARY_COLUMNS},description,l_description,effects`
const TEXT_FIELDS = ['title', 'company', 'description', 'l_description', 'effects'] as const

async function rest<T>(path: string, params: URLSearchParams, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}?${params}`, {
    method: 'GET',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Accept: 'application/json',
      ...headers,
    },
  })
  if (!res.ok) {
    throw new Error(`Supabase error ${res.status}: ${await res.text()}`)
  }
  return (await res.json()) as T
}

// Fetches every matching row, paging past PostgREST's max-rows limit.
async function fetchAll<T>(params: URLSearchParams): Promise<T[]> {
  const rows: T[] = []
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = new URLSearchParams(params)
    page.set('limit', String(PAGE_SIZE))
    page.set('offset', String(offset))
    const batch = await rest<T[]>('cases', page)
    rows.push(...batch)
    if (batch.length < PAGE_SIZE) return rows
  }
}

// Values inside an or=(...) list must be quoted; plain column filters take them literally.
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

// Russian words change endings ("металлургия" / "металлургических"), so match on a crude stem.
function stem(word: string): string {
  return word.length > 6 ? word.slice(0, Math.max(5, word.length - 3)) : word
}

// Words present in almost every case; matching on them only adds noise.
const STOP_STEMS = new Set(
  [
    'компания', 'компаний', 'кейс', 'кейсы', 'кейсов', 'применение', 'применения', 'использование',
    'использования', 'генеративный', 'генеративного', 'генеративные', 'искусственный', 'искусственного',
    'интеллект', 'интеллекта', 'найди', 'найти', 'покажи', 'примеры', 'пример', 'для', 'при', 'как', 'что',
    'это', 'или', 'the', 'and', 'for', 'genai', 'gen',
  ].map((w) => stem(w)),
)

export function keywords(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3)
  return [...new Set(words.map(stem))].filter((w) => !STOP_STEMS.has(w))
}

export interface SearchParams {
  query?: string
  industry?: string
  business_function?: string
  company?: string
  limit: number
}

export interface SearchResult {
  total: number
  cases: (CaseSummary & { matched_keywords?: string[] })[]
}

export async function searchCases(p: SearchParams): Promise<SearchResult> {
  const params = new URLSearchParams()
  params.set('order', 'published_at.desc.nullslast')
  if (p.industry) params.append('industry', `ilike.*${p.industry}*`)
  if (p.business_function) params.append('business_function', `ilike.*${p.business_function}*`)
  if (p.company) params.append('company', `ilike.*${p.company}*`)

  const words = p.query ? keywords(p.query) : []
  if (words.length === 0) {
    params.set('select', SUMMARY_COLUMNS)
    const rows = await fetchAll<CaseSummary>(params)
    return { total: rows.length, cases: rows.slice(0, p.limit) }
  }

  // Any keyword in any text field; rank afterwards by how many keywords matched.
  params.set('select', SEARCH_COLUMNS)
  const conditions = words.flatMap((w) => TEXT_FIELDS.map((f) => `${f}.ilike.${quote(`*${w}*`)}`))
  params.set('or', `(${conditions.join(',')})`)
  const rows = await fetchAll<CaseSummary & Record<string, string | null>>(params)

  const ranked = rows
    .map((row) => {
      const title = (row.title ?? '').toLowerCase()
      const text = TEXT_FIELDS.map((f) => row[f] ?? '').join(' ').toLowerCase()
      const matched = words.filter((w) => text.includes(w))
      const score = matched.length * 10 + words.filter((w) => title.includes(w)).length * 3
      return { row, matched, score }
    })
    .sort((a, b) => b.score - a.score)

  return {
    total: ranked.length,
    cases: ranked.slice(0, p.limit).map(({ row, matched }) => ({
      id: row.id,
      title: row.title,
      company: row.company,
      industry: row.industry,
      business_function: row.business_function,
      published_at: row.published_at,
      matched_keywords: matched,
    })),
  }
}

export async function getCase(id: string): Promise<Record<string, unknown> | null> {
  const params = new URLSearchParams({ select: '*', id: `eq.${id}` })
  const rows = await rest<Record<string, unknown>[]>('cases', params)
  return rows[0] ?? null
}

export interface Filters {
  industries: { name: string; count: number }[]
  business_functions: { name: string; count: number }[]
  total_cases: number
}

function countBy(values: (string | null)[]): { name: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const v of values) {
    const name = v?.trim()
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru'))
}

export async function listFilters(): Promise<Filters> {
  const rows = await fetchAll<{ industry: string | null; business_function: string | null }>(
    new URLSearchParams({ select: 'industry,business_function' }),
  )
  return {
    industries: countBy(rows.map((r) => r.industry)),
    business_functions: countBy(rows.map((r) => r.business_function)),
    total_cases: rows.length,
  }
}
