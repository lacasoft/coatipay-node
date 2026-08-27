import type { Config } from '../lib/config'

declare module 'fastify' {
  interface FastifyInstance {
    config: Config
  }
}
