// Proxy serverless para o Vercel.
//
// No `npm run dev`, o proxy do Vite leva /orion, /iota e /sth até o servidor FIWARE.
// Esse proxy não existe no build publicado, e o navegador também não pode chamar o
// servidor direto: o site no Vercel é HTTPS e o servidor responde em HTTP (conteúdo
// misto é bloqueado, principalmente no celular). Esta função faz esse papel.
//
// O IP do servidor vem da variável de ambiente FIWARE_HOST (Vercel > Settings >
// Environment Variables). O navegador nunca escolhe o destino, só qual serviço usar.

const SERVICES = {
  orion: 1026, // Orion Context Broker
  iota: 4041, // IoT Agent UltraLight
  sth: 8666, // STH-Comet (histórico)
}

const FORWARD_HEADERS = ['fiware-service', 'fiware-servicepath', 'content-type', 'accept']
const TIMEOUT_MS = 8000

function sendJson(res, status, message) {
  res.status(status).setHeader('Content-Type', 'application/json')
  res.send(JSON.stringify({ error: message }))
}

export default async function handler(req, res) {
  const host = (process.env.FIWARE_HOST || '').trim()
  if (!host) {
    return sendJson(res, 500, 'Variável FIWARE_HOST não configurada no Vercel.')
  }

  // Normalmente o vercel.json entrega ?svc=orion&p=v2/entities/... Se a URL original
  // chegar intacta (/orion/v2/...), o serviço e o caminho são lidos dela.
  const url = new URL(req.url, 'http://localhost')
  let svc = url.searchParams.get('svc')
  let path = url.searchParams.get('p')
  if (!svc) {
    const m = url.pathname.match(/^\/(orion|iota|sth)(?:\/(.*))?$/)
    if (m) [, svc, path] = m
  }

  const port = SERVICES[svc]
  if (!port) return sendJson(res, 404, 'Serviço desconhecido.')

  // Repassa a query string original, sem os parâmetros internos do rewrite
  url.searchParams.delete('svc')
  url.searchParams.delete('p')
  const query = url.searchParams.toString()
  const target = `http://${host}:${port}/${(path || '').replace(/^\/+/, '')}${query ? `?${query}` : ''}`

  const headers = {}
  for (const name of FORWARD_HEADERS) {
    if (req.headers[name]) headers[name] = req.headers[name]
  }

  let body
  if (!['GET', 'HEAD', 'DELETE'].includes(req.method) && req.body !== undefined && req.body !== '') {
    body = typeof req.body === 'string' || Buffer.isBuffer(req.body) ? req.body : JSON.stringify(req.body)
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const upstream = await fetch(target, { method: req.method, headers, body, signal: ctrl.signal })
    const buf = Buffer.from(await upstream.arrayBuffer())
    const type = upstream.headers.get('content-type')
    if (type) res.setHeader('Content-Type', type)
    res.setHeader('Cache-Control', 'no-store')
    res.status(upstream.status).send(buf)
  } catch (e) {
    const timedOut = e.name === 'AbortError'
    sendJson(
      res,
      timedOut ? 504 : 502,
      timedOut
        ? `O servidor FIWARE (${svc}) não respondeu em ${TIMEOUT_MS / 1000}s. Confira se a instância está ligada e se o IP em FIWARE_HOST está certo.`
        : `Não foi possível alcançar o servidor FIWARE (${svc}): ${e.cause?.code || e.message}`,
    )
  } finally {
    clearTimeout(timer)
  }
}
