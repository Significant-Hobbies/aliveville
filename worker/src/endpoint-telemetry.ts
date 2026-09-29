import { createAppHealthClient, type AppHealthClient } from '@saas-maker/app-health';

interface TelemetryEnv {
  APP_HEALTH_INGEST_KEY?: string;
  APP_HEALTH_ENVIRONMENT?: string;
}

export interface EndpointSummary {
  method: string;
  route: string;
  status_code: number;
  duration_ms: number;
}

type RouteKey = `${string} ${string}`;

const API_ROUTES = new Map<RouteKey, string>([
  // SSE (/api/events and stream-capable /api/dialogue) and admin restore have
  // different privacy or duration semantics, so they are intentionally absent.
  ['GET /api/state', '/api/state'],
  ['GET /api/worlds', '/api/worlds'],
  ['POST /api/worlds/select', '/api/worlds/select'],
  ['POST /api/import-fandom', '/api/import-fandom'],
  ['POST /api/import-world-source', '/api/import-world-source'],
  ['POST /api/import-anime', '/api/import-anime'],
  ['GET /api/save', '/api/save'],
  ['POST /api/reset', '/api/reset'],
  ['GET /api/agent-loop/status', '/api/agent-loop/status'],
  ['POST /api/agent-loop/start', '/api/agent-loop/start'],
  ['POST /api/agent-loop/stop', '/api/agent-loop/stop'],
  ['POST /api/agent-loop/step', '/api/agent-loop/step'],
  ['GET /api/dialogue/history', '/api/dialogue/history'],
  ['POST /api/dialogue/choose', '/api/dialogue/choose'],
  ['POST /api/arc/event', '/api/arc/event'],
  ['POST /api/tick', '/api/tick'],
]);

/** Return a declared route template; unmatched concrete paths are never reported. */
export function matchEndpointRoute(method: string, path: string): string | null {
  return API_ROUTES.get(`${method.toUpperCase()} ${path}` as RouteKey) ?? null;
}

export async function withEndpointTelemetry(
  method: string,
  path: string,
  env: TelemetryEnv,
  waitUntil: (delivery: Promise<unknown>) => void,
  dispatch: () => Promise<Response>,
  now: () => number = () => performance.now(),
  record: typeof reportEndpoint = reportEndpoint
): Promise<Response> {
  const route = matchEndpointRoute(method, path);
  if (route === null) return dispatch();

  const startedAt = now();
  let response: Response;
  try {
    response = await dispatch();
  } catch (error) {
    record(env, waitUntil, {
      method,
      route,
      status_code: 500,
      duration_ms: Math.max(0, Math.round(now() - startedAt)),
    });
    throw error;
  }

  record(env, waitUntil, {
    method,
    route,
    status_code: response.status,
    duration_ms: Math.max(0, Math.round(now() - startedAt)),
  });
  return response;
}

let client: AppHealthClient | null = null;
let clientKey: string | null = null;
let clientEnvironment: string | undefined;

function getClient(env: TelemetryEnv): AppHealthClient | null {
  const key = env.APP_HEALTH_INGEST_KEY;
  if (!key) return null;
  if (!client || clientKey !== key || clientEnvironment !== env.APP_HEALTH_ENVIRONMENT) {
    clientKey = key;
    clientEnvironment = env.APP_HEALTH_ENVIRONMENT;
    client = createAppHealthClient({
      key,
      ...(env.APP_HEALTH_ENVIRONMENT !== undefined
        ? { environment: env.APP_HEALTH_ENVIRONMENT }
        : {}),
      endpoint: 'https://ingest.sassmaker.com/v1/ingest',
      runtime: 'worker',
      disableTimer: true,
      requestTimeoutMs: 1_500,
      maxRetries: 0,
    });
  }
  return client;
}

/** Record only the V1 endpoint summary. Delivery runs after the game response. */
export function reportEndpoint(
  env: TelemetryEnv,
  waitUntil: (delivery: Promise<unknown>) => void,
  summary: EndpointSummary
): void {
  try {
    const appHealth = getClient(env);
    if (!appHealth) return;
    appHealth.record(summary);
    waitUntil(appHealth.flush());
  } catch {
    // Telemetry is optional and must never affect gameplay.
  }
}
