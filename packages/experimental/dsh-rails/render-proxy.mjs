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

// Health results are logged only when they change, per source, so the deploy
// log shows whether Render's checks arrive and what they receive without
// repeating a line every few seconds.
const lastHealth = new Map()
function noteHealth(source, result) {
  if (lastHealth.get(source) === result) return
  lastHealth.set(source, result)
  console.log(`render-proxy: ${source} GET /healthz -> ${result}`)
}

function healthSource(req) {
  const address = req.socket.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::ffff:127.0.0.1' ? 'self-check' : `external ${address}`
}

const server = createServer((req, res) => {
  const isHealth = req.url === '/healthz' || req.url?.startsWith('/healthz?') === true
  const upstream = httpRequest({
    host: upstreamHost,
    port: upstreamPort,
    method: req.method,
    path: req.url,
    headers: req.headers,
  }, (upstreamRes) => {
    if (isHealth) noteHealth(healthSource(req), String(upstreamRes.statusCode))
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.rawHeaders)
    upstreamRes.pipe(res)
  })
  upstream.on('error', (error) => {
    if (isHealth) noteHealth(healthSource(req), `502 (dsh unreachable: ${error.code ?? error.message})`)
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' })
      res.end(`dsh upstream unavailable: ${error.message}\n`)
    } else {
      res.destroy(error)
    }
  })
  req.pipe(upstream)
})

// Render's port scan and health checks connect from outside the container; the
// first connection from each address shows whether they arrive at all.
const seenPeers = new Set()
server.on('connection', (socket) => {
  const address = socket.remoteAddress ?? 'unknown'
  if (address === '127.0.0.1' || address === '::ffff:127.0.0.1' || seenPeers.has(address) || seenPeers.size >= 20) return
  seenPeers.add(address)
  console.log(`render-proxy: first connection from ${address}`)
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
// succeeds, so the log separates "DSH is not healthy" from "Render's checks
// never arrive".
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
