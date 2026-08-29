import { URL } from 'node:url'
import { defineConfig, type Plugin, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * The HTTP endpoints are Vercel functions in production. Mounting the same
 * handlers in dev keeps one implementation instead of mocks that drift.
 */
function mountApi(server: ViteDevServer, route: string, modulePath: string) {
  server.middlewares.use(route, async (req: any, res: any) => {
    const { default: handler } = await server.ssrLoadModule(modulePath)
    const url = new URL(req.url ?? '', 'http://localhost')
    const shim = {
      query: Object.fromEntries(url.searchParams.entries()),
    }
    const reply = {
      statusCode: 200,
      setHeader: (name: string, value: string) => res.setHeader(name, value),
      status(code: number) {
        this.statusCode = code
        return this
      },
      json(body: unknown) {
        res.statusCode = this.statusCode
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(body))
      },
    }
    await handler(shim, reply)
  })
}

function localApis(): Plugin {
  return {
    name: 'graft-local-apis',
    configureServer(server) {
      mountApi(server, '/api/fetch', '/api/fetch.ts')
      mountApi(server, '/api/verify', '/api/verify.ts')
    },
  }
}

export default defineConfig({
  plugins: [react(), localApis()],
  server: {
    host: '127.0.0.1',
    port: 4173,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
  },
})
