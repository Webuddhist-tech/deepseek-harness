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

const server = createServer((req, res) => {
  const upstream = httpRequest({
    host: upstreamHost,
    port: upstreamPort,
    method: req.method,
    path: req.url,
    headers: req.headers,
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.rawHeaders)
    upstreamRes.pipe(res)
  })
  upstream.on('error', (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' })
      res.end(`dsh upstream unavailable: ${error.message}\n`)
    } else {
      res.destroy(error)
    }
  })
  req.pipe(upstream)
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

server.listen(listenPort, '0.0.0.0', () => {
  console.log(`render-proxy: 0.0.0.0:${listenPort} -> ${upstreamHost}:${upstreamPort}`)
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
