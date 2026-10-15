# usegenai MCP server

MCP-сервер для поиска кейсов применения генеративного ИИ из базы [usegenai.ru](https://usegenai.ru).
Работает только на чтение: отправляет в Supabase лишь GET-запросы к таблице `cases`.

## Инструменты

| Инструмент | Что делает |
|---|---|
| `list_filters` | Отрасли и бизнес-функции с количеством кейсов |
| `search_cases` | Поиск по ключевым словам (`query`) и фильтрам `industry`, `business_function`, `company` |
| `get_case` | Полная карточка кейса по `id` |

## Эндпоинты

- `POST /mcp` — MCP (Streamable HTTP, stateless).
- `GET /sse` + `POST /messages` — устаревший транспорт HTTP+SSE для старых клиентов.
- `GET /health` — проверка работоспособности.

Авторизация ключом `MCP_API_KEY` любым из способов: `Authorization: Bearer <ключ>`, Basic-авторизация
(логин любой, пароль — ключ), заголовок `X-API-Key: <ключ>` или параметр `?key=<ключ>`.

## Переменные окружения

См. [.env.example](.env.example): `SUPABASE_URL`, `SUPABASE_KEY`, `MCP_API_KEY`, `PORT`, `SITE_URL`.

## Локальный запуск

```bash
npm install
cp .env.example .env   # заполнить значения
npm run dev
```

## Деплой

Dokploy → Application → GitHub, Build Type: Dockerfile, порт 3000, домен `mcp.usegenai.ru` с HTTPS.

## Подключение клиента

Claude Code:

```bash
claude mcp add --transport http usegenai https://mcp.usegenai.ru/mcp --header "Authorization: Bearer <MCP_API_KEY>"
```

Claude Desktop / Cursor (`mcpServers` в конфиге):

```json
{
  "mcpServers": {
    "usegenai": {
      "url": "https://mcp.usegenai.ru/mcp",
      "headers": { "Authorization": "Bearer <MCP_API_KEY>" }
    }
  }
}
```
