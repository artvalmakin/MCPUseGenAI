import { timingSafeEqual } from 'node:crypto'
import express, { type NextFunction, type Request, type Response } from 'express'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createServer } from './server.js'

const PORT = Number(process.env.PORT ?? 3000)
const MCP_API_KEY = process.env.MCP_API_KEY ?? ''

if (MCP_API_KEY.length < 16) {
  throw new Error('MCP_API_KEY must be set (at least 16 characters)')
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

// Clients differ in how they send credentials, so accept every common form:
// "Authorization: Bearer <key>", Basic auth with the key as password (any login), "X-API-Key: <key>" or "?key=<key>".
function extractKey(req: Request): string {
  const header = req.headers.authorization ?? ''
  const [scheme, value = ''] = header.split(' ', 2)
  if (/^bearer$/i.test(scheme)) return value.trim()
  if (/^basic$/i.test(scheme)) {
    const decoded = Buffer.from(value, 'base64').toString('utf8')
    return decoded.slice(decoded.indexOf(':') + 1)
  }
  const apiKey = req.headers['x-api-key']
  if (typeof apiKey === 'string') return apiKey.trim()
  return typeof req.query.key === 'string' ? req.query.key : ''
}

function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const token = extractKey(req)
  if (token && safeEqual(token, MCP_API_KEY)) return next()
  res
    .status(401)
    .set('WWW-Authenticate', 'Bearer realm="usegenai-mcp"')
    .json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: invalid or missing API key' }, id: null })
}

// The SDK rejects requests whose Accept header lacks text/event-stream; many clients only send application/json.
// It reads headers from rawHeaders, so patch both views.
function normalizeAccept(req: Request) {
  const accept = req.headers.accept ?? ''
  if (accept.includes('application/json') && accept.includes('text/event-stream')) return
  const value = 'application/json, text/event-stream'
  req.headers.accept = value
  const raw: string[] = []
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() !== 'accept') raw.push(req.rawHeaders[i], req.rawHeaders[i + 1])
  }
  raw.push('Accept', value)
  req.rawHeaders.splice(0, req.rawHeaders.length, ...raw)
}

const app = express()
app.set('trust proxy', true)

// Browser-based clients need CORS.
app.use((req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, X-API-Key, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate',
  })
  if (req.method === 'OPTIONS') return void res.sendStatus(204)
  next()
})

app.use((req, res, next) => {
  const started = Date.now()
  res.on('finish', () => {
    const ua = String(req.headers['user-agent'] ?? '-').slice(0, 80)
    console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - started}ms ip=${req.ip} ua="${ua}"`)
  })
  next()
})

app.use(express.json({ limit: '1mb' }))

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

// Streamable HTTP (current MCP transport). Stateless mode: a fresh server and transport per request.
app.post('/mcp', requireApiKey, async (req, res) => {
  normalizeAccept(req)
  const server = createServer()
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => {
    transport.close()
    server.close()
  })
  try {
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (err) {
    console.error('MCP request failed:', err)
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null })
    }
  }
})

app.all('/mcp', (_req, res) => {
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null })
})

// Legacy HTTP+SSE transport for clients that do not support Streamable HTTP yet.
const sseTransports = new Map<string, SSEServerTransport>()

app.get('/sse', requireApiKey, async (_req, res) => {
  const transport = new SSEServerTransport('/messages', res)
  const server = createServer()
  sseTransports.set(transport.sessionId, transport)
  res.on('close', () => {
    sseTransports.delete(transport.sessionId)
    server.close()
  })
  await server.connect(transport)
})

app.post('/messages', async (req, res) => {
  const transport = sseTransports.get(String(req.query.sessionId ?? ''))
  if (!transport) return void res.status(404).json({ error: 'Unknown or expired sessionId' })
  await transport.handlePostMessage(req, res, req.body)
})

app.listen(PORT, () => {
  console.log(`usegenai MCP server listening on :${PORT} (POST /mcp, GET /sse)`)
})
