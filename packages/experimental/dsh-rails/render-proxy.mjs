// Render ingress relay for the DSH `web` profile.
//
// Render routes traffic only to a port bound on 0.0.0.0, while the DSH
// webserver refuses wildcard bind addresses. This relay binds 0.0.0.0:$PORT
// and forwards HTTP requests and WebSocket upgrades unchanged (Host and Origin
// included) to DSH on loopback. DSH still enforces its token and its /api
// Host/Origin fence, which accepts the public hostname through --trusted-host.
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'

const listenPort = Number(process.env.PORT ?? '10000')
const upstreamHost = '127.0.0.1'
const upstreamPort = Number(process.env.DSH_UPSTREAM_PORT ?? '3080')
const publicHost = process.env.RENDER_EXTERNAL_HOSTNAME

// The deploy log shows what reaches the relay and what it answers: each
// peer's first connection, each request whose result changed since the last
// one with the same peer, method, and path, and each unparseable request.
// Every list is capped so a probe loop cannot flood the log.
const LOG_LIMIT = 40
const seenPeers = new Set()
const lastResults = new Map()
let unparseableLogged = 0

function logRequest(req, result, startedAt) {
  const key = `${req.socket.remoteAddress} ${req.method} ${req.url}`
  if (lastResults.get(key) === result || lastResults.size >= LOG_LIMIT) return
  lastResults.set(key, result)
  console.log(`render-proxy: ${key} host=${req.headers.host ?? '-'} -> ${result} (${Date.now() - startedAt}ms)`)
}

const server = createServer((req, res) => {
  const startedAt = Date.now()
  const upstream = httpRequest({
    host: upstreamHost,
    port: upstreamPort,
    method: req.method,
    path: req.url,
    headers: req.headers,
  }, (upstreamRes) => {
    logRequest(req, String(upstreamRes.statusCode), startedAt)
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.rawHeaders)
    upstreamRes.pipe(res)
  })
  upstream.on('error', (error) => {
    logRequest(req, `502 (dsh unreachable: ${error.code ?? error.message})`, startedAt)
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' })
      res.end(`dsh upstream unavailable: ${error.message}\n`)
    } else {
      res.destroy(error)
    }
  })
  req.pipe(upstream)
})

server.on('connection', (socket) => {
  const address = socket.remoteAddress ?? 'unknown'
  if (seenPeers.has(address) || seenPeers.size >= LOG_LIMIT) return
  seenPeers.add(address)
  console.log(`render-proxy: first connection from ${address}`)
})

server.on('clientError', (error, socket) => {
  if (unparseableLogged < LOG_LIMIT) {
    unparseableLogged += 1
    console.log(`render-proxy: unparseable request from ${socket.remoteAddress}: ${error.code ?? error.message}`)
  }
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  else socket.destroy()
})

server.on('upgrade', (req, socket, head) => {
  const upstream = connect(upstreamPort, upstreamHost, () => {
    const headerLines = []
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      headerLines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
    }
    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headerLines.join('\r\n')}\r\n\r\n`)
    if (head.length > 0) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
})

// Probe this relay's own /healthz with the public Host header until it
// succeeds; the request log then shows when DSH became healthy.
function selfCheck() {
  const probe = httpRequest({
    host: '127.0.0.1',
    port: listenPort,
    path: '/healthz',
    headers: publicHost === undefined ? {} : { host: publicHost },
  }, (probeRes) => {
    probeRes.resume()
    if (probeRes.statusCode !== 200) setTimeout(selfCheck, 5000)
  })
  probe.on('error', () => setTimeout(selfCheck, 5000))
  probe.end()
}

server.listen(listenPort, '0.0.0.0', () => {
  console.log(`render-proxy: listening on ${JSON.stringify(server.address())} -> ${upstreamHost}:${upstreamPort}`)
  selfCheck()
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
