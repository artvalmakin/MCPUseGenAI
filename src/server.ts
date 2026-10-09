import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { getCase, listFilters, searchCases } from './db.js'

const SITE_URL = (process.env.SITE_URL ?? 'https://usegenai.ru').replace(/\/+$/, '')

function json(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}

function error(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true }
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: 'usegenai-cases', version: '0.1.0' },
    {
      instructions:
        'База кейсов применения генеративного ИИ в компаниях (usegenai.ru). ' +
        'Порядок работы: 1) list_filters — узнать точные названия отраслей и бизнес-функций; ' +
        '2) search_cases — найти кейсы по ключевым словам и/или фильтрам; ' +
        '3) get_case — получить полную карточку нужного кейса по id.',
    },
  )

  server.registerTool(
    'list_filters',
    {
      title: 'Список отраслей и функций',
      description:
        'Возвращает все отрасли (industry) и бизнес-функции (business_function), встречающиеся в базе, ' +
        'с количеством кейсов. Вызывай перед search_cases, чтобы подобрать точные значения фильтров ' +
        '(например, металлургия относится к «Обрабатывающая промышленность и производство» или ' +
        '«Горнодобывающая промышленность…», закупки — к «Закупки и поиск поставщиков» или «Управление закупками»).',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json(await listFilters()),
  )

  server.registerTool(
    'search_cases',
    {
      title: 'Поиск кейсов',
      description:
        'Ищет кейсы применения генеративного ИИ. Все параметры необязательны и комбинируются. ' +
        'query — ключевые слова (ищутся в названии, компании, описании и эффектах; результаты ранжируются по числу совпавших слов). ' +
        'industry и business_function — фильтры по подстроке; точные значения бери из list_filters. ' +
        'Возвращает краткий список (id, название, компания, отрасль, функция); полную карточку получай через get_case. ' +
        'Если с фильтрами ничего не нашлось — повтори запрос без части фильтров или с другими словами. ' +
        'Отраслевые слова (например, «металлург», «банк») полезно передавать в query: в базе крупные отрасли, а не подотрасли.',
      inputSchema: {
        query: z.string().optional().describe('Ключевые слова, например «закупки поставщики тендер»'),
        industry: z.string().optional().describe('Отрасль, например «Металлургия»'),
        business_function: z.string().optional().describe('Бизнес-функция, например «Закупки»'),
        company: z.string().optional().describe('Название компании, например «Северсталь»'),
        limit: z.number().int().min(1).max(50).default(10).describe('Сколько кейсов вернуть (1–50)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, industry, business_function, company, limit }) => {
      const result = await searchCases({ query, industry, business_function, company, limit })
      return json({
        total_found: result.total,
        returned: result.cases.length,
        cases: result.cases.map((c) => ({ ...c, url: `${SITE_URL}/cases/${c.id}` })),
      })
    },
  )

  server.registerTool(
    'get_case',
    {
      title: 'Карточка кейса',
      description: 'Возвращает полную карточку кейса по id (из результатов search_cases): описание, эффекты, источник и т. д.',
      inputSchema: {
        id: z.string().uuid().describe('Идентификатор кейса (uuid)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      const found = await getCase(id)
      if (!found) return error(`Кейс с id ${id} не найден`)
      return json({ ...found, url: `${SITE_URL}/cases/${id}` })
    },
  )

  return server
}
