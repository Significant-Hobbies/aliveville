export { GameSessionDO } from './session-do.ts';

import { serveIndexNowKey } from './indexnow.ts';
import { withEndpointTelemetry } from './endpoint-telemetry.ts';

interface Env {
  SESSIONS: DurableObjectNamespace;
  ASSETS: Fetcher;
  MAX_BODY_BYTES?: string;
  APP_HEALTH_INGEST_KEY?: string;
  APP_HEALTH_ENVIRONMENT?: string;
}

const MAX_BODY_BYTES = 1_500_000;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    const indexNowKey = serveIndexNowKey(url.pathname);
    if (indexNowKey) return indexNowKey;

    // the game lives under /game (aliveville.com root is the landing site)
    if (url.pathname === '/' || url.pathname === '/game') {
      return Response.redirect(new URL('/game/', url).toString(), 302);
    }
    if (url.pathname.startsWith('/game/api/')) {
      const path = url.pathname.slice('/game'.length);
      return withEndpointTelemetry(
        request.method,
        path,
        env,
        (delivery) => ctx.waitUntil(delivery),
        async () => {
          const length = Number(request.headers.get('content-length') ?? 0);
          if (length > MAX_BODY_BYTES) {
            return new Response(JSON.stringify({ error: 'payload_too_large' }), {
              status: 413,
              headers: { 'content-type': 'application/json' },
            });
          }
          const raw =
            url.searchParams.get('session') ?? request.headers.get('x-session-id') ?? 'main';
          const sessionId = /^[a-zA-Z0-9_-]{1,48}$/.test(raw) ? raw : 'main';
          const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
          // the session DO speaks /api/* — strip the mount prefix
          url.pathname = path;
          return stub.fetch(new Request(url.toString(), request));
        }
      );
    }
    return env.ASSETS.fetch(request);
  },
};
