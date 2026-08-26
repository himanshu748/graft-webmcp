import { URL } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * The intake endpoint is a Vercel function in production. Mounting the same
 * handler in dev keeps one implementation instead of a mock that drifts.
 */
function intakeApi(): Plugin {
  return {
    name: 'graft-intake-api',
    configureServer(server) {
      server.middlewares.use('/api/fetch', async (req: any, res: any) => {
        const { default: handler } = await server.ssrLoadModule('/api/fetch.ts')
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
    },
  }
}

export default defineConfig({
  plugins: [react(), intakeApi()],
  server: {
    host: '127.0.0.1',
    port: 4173,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
  },
})
