/**
 * Cloudflare Pages Functions middleware — agent SEO surfaces for aliveville.com.
 * Handles /openapi.json, JSON error responses, Accept: text/markdown negotiation
 * for pages with .md alternates, Vary: Accept, rate-limit headers, and
 * agent-friendly 404s with markdown recovery body.
 */

interface Env {
  ASSETS: Fetcher;
}

const SITE_ORIGIN = 'https://aliveville.com';

const RATE_LIMIT = 60;
const RATE_LIMIT_WINDOW = 60;

const ERROR_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Machine-readable error code' },
        message: { type: 'string', description: 'Human-readable error message' },
        path: { type: 'string', description: 'The request path that caused the error' },
      },
      required: ['code', 'message'],
    },
  },
  required: ['error'],
};

const OPENAPI_SPEC = {
  openapi: '3.1.0',
  info: {
    title: 'Aliveville public API',
    version: '1.0.0',
    description:
      'Browser-playable 3D AI world simulator. The public web API exposes read-only agent surfaces.',
    contact: { name: 'Aliveville', url: SITE_ORIGIN },
  },
  servers: [{ url: SITE_ORIGIN }],
  tags: [{ name: 'agent-surfaces', description: 'Machine-readable public surfaces' }],
  components: {
    schemas: {
      AgentCatalog: {
        type: 'object',
        description: 'JSON inventory of public agent surfaces and per-page markdown alternates.',
        properties: {
          name: { type: 'string' },
          version: { type: 'string' },
          url: { type: 'string', format: 'uri' },
          llms: { type: 'string', format: 'uri' },
          sitemap: { type: 'string', format: 'uri' },
          openapi: { type: 'string', format: 'uri' },
          markdown: {
            type: 'object',
            properties: {
              suffix: { type: 'string' },
              negotiation: { type: 'boolean' },
            },
          },
          surfaces: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                url: { type: 'string', format: 'uri' },
                md: { type: 'string', format: 'uri' },
                kind: { type: 'string' },
                description: { type: 'string' },
              },
            },
          },
        },
      },
      ErrorResponse: ERROR_RESPONSE_SCHEMA,
    },
  },
  paths: {
    '/api/ai': {
      get: {
        operationId: 'getAgentCatalog',
        tags: ['agent-surfaces'],
        summary: 'Agent catalog',
        description:
          'JSON inventory of public agent surfaces: llms.txt, sitemap, robots, and per-page markdown alternates.',
        responses: {
          '200': {
            description: 'Agent catalog JSON',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/AgentCatalog' } },
            },
          },
          '404': {
            description: 'Unknown API path',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
            },
          },
          '429': {
            description: 'Rate limit exceeded',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
            },
          },
          '500': {
            description: 'Internal server error',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
            },
          },
        },
      },
    },
    '/llms.txt': {
      get: {
        operationId: 'getLlmsTxt',
        tags: ['agent-surfaces'],
        summary: 'llms.txt index',
        description: 'Compact agent index following the llms.txt convention.',
        responses: {
          '200': {
            description: 'Markdown index',
            content: { 'text/plain': { schema: { type: 'string' } } },
          },
          '429': {
            description: 'Rate limit exceeded',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
            },
          },
        },
      },
    },
    '/sitemap.xml': {
      get: {
        operationId: 'getSitemap',
        tags: ['agent-surfaces'],
        summary: 'Sitemap',
        description: 'XML sitemap of all canonical public HTML pages.',
        responses: {
          '200': {
            description: 'XML sitemap',
            content: { 'application/xml': { schema: { type: 'string' } } },
          },
          '429': {
            description: 'Rate limit exceeded',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
            },
          },
        },
      },
    },
    '/openapi.json': {
      get: {
        operationId: 'getOpenApiSpec',
        tags: ['agent-surfaces'],
        summary: 'OpenAPI specification',
        description: 'This document.',
        responses: {
          '200': {
            description: 'OpenAPI 3.1 spec',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          '429': {
            description: 'Rate limit exceeded',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
            },
          },
        },
      },
    },
  },
};

function wantsMarkdown(request: Request): boolean {
  const accept = (request.headers.get('accept') || '').toLowerCase();
  if (!accept.includes('text/markdown')) return false;
  if (!accept.includes('text/html')) return true;
  return accept.indexOf('text/markdown') < accept.indexOf('text/html');
}

function normalizePath(pathname: string): string {
  if (!pathname || pathname === '/') return '/';
  const withSlash = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return withSlash.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
}

function markdownPathFor(pathname: string): string {
  const path = normalizePath(pathname);
  return path === '/' ? '/index.md' : `${path}.md`;
}

function isMarkdownContentType(contentType: string | null): boolean {
  return contentType?.split(';', 1)[0].trim().toLowerCase() === 'text/markdown';
}

async function inspectMarkdown(response: Response): Promise<{
  isMarkdown: boolean;
  body: ReadableStream<Uint8Array> | null;
}> {
  if (response.status !== 200 || !isMarkdownContentType(response.headers.get('content-type'))) {
    await response.body?.cancel();
    return { isMarkdown: false, body: null };
  }
  if (!response.body) return { isMarkdown: true, body: null };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const prefixChunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < 1024) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      const prefixChunk = value.subarray(0, 1024 - total);
      prefixChunks.push(prefixChunk);
      total += prefixChunk.byteLength;
      if (prefixChunk.byteLength < value.byteLength) break;
    }
  } catch (error) {
    await reader.cancel(error);
    reader.releaseLock();
    throw error;
  }

  const prefix = new Uint8Array(total);
  let offset = 0;
  for (const chunk of prefixChunks) {
    prefix.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder()
    .decode(prefix)
    .replace(/^\uFEFF/, '')
    .trimStart();
  const documentStart = text.replace(/^(?:<!--[\s\S]*?-->\s*)+/, '');
  if (/^(?:<!doctype\s+html\b|<html\b)/i.test(documentStart)) {
    await reader.cancel();
    reader.releaseLock();
    return { isMarkdown: false, body: null };
  }

  let chunkIndex = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (chunkIndex < chunks.length) {
        controller.enqueue(chunks[chunkIndex++]);
        return;
      }
      try {
        const { done, value } = await reader.read();
        if (done) {
          reader.releaseLock();
          controller.close();
        } else if (value) {
          controller.enqueue(value);
        }
      } catch (error) {
        reader.releaseLock();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
      }
    },
  });
  return { isMarkdown: true, body };
}

function isXmlContentType(contentType: string | null): boolean {
  const mediaType = contentType?.split(';', 1)[0].trim().toLowerCase();
  return (
    mediaType === 'application/xml' ||
    mediaType === 'text/xml' ||
    /^application\/[\w.+-]+\+xml$/.test(mediaType || '')
  );
}

function withRateLimit(headers: Headers): Headers {
  headers.set('ratelimit-limit', String(RATE_LIMIT));
  headers.set('ratelimit-remaining', String(RATE_LIMIT));
  headers.set('ratelimit-reset', String(RATE_LIMIT_WINDOW));
  return headers;
}

function addVary(headers: Headers, ...values: string[]): void {
  const existing = (headers.get('vary') || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (existing.includes('*')) return;
  const seen = new Set(existing.map((value) => value.toLowerCase()));
  for (const value of values) {
    if (!seen.has(value.toLowerCase())) {
      existing.push(value);
      seen.add(value.toLowerCase());
    }
  }
  headers.set('vary', existing.join(', '));
}

async function fetchMarkdownAsset(env: Env, url: URL, request: Request): Promise<Response> {
  const headers = new Headers();
  const accept = request.headers.get('accept');
  if (accept) headers.set('accept', accept);
  const probe = new Request(url.toString(), { method: 'GET', headers });
  return env.ASSETS.fetch(probe);
}

async function passThroughAssetError(response: Response, request: Request): Promise<Response> {
  const headers = withRateLimit(new Headers(response.headers));
  addVary(headers, 'Accept', 'Accept-Encoding');
  const bodyless = request.method === 'HEAD' || response.status === 204 || response.status === 304;
  if (bodyless) await response.body?.cancel();
  return new Response(bodyless ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonError(status: number, code: string, message: string, path: string): Response {
  const headers = withRateLimit(
    new Headers({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    })
  );
  return new Response(JSON.stringify({ error: { code, message, path } }), { status, headers });
}

function markdown404(pathname: string, origin: string, method: string = 'GET'): Response {
  const body = `# 404 — Not Found

\`${pathname}\` does not exist on ${origin}.

## Where to look next

- [Home](${origin}/)
- [Sitemap](${origin}/sitemap.xml)
- [Agent index](${origin}/llms.txt)
- [Agent catalog (JSON)](${origin}/api/ai)
- [OpenAPI spec](${origin}/openapi.json)
`;
  const headers = withRateLimit(
    new Headers({
      'content-type': 'text/markdown; charset=utf-8',
      'cache-control': 'no-store',
      vary: 'Accept, Accept-Encoding',
      'x-content-type-options': 'nosniff',
    })
  );
  return new Response(method === 'HEAD' ? null : body, { status: 404, headers });
}

function notFound(pathname: string, method: string): Response {
  const headers = withRateLimit(
    new Headers({
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      vary: 'Accept, Accept-Encoding',
      'x-content-type-options': 'nosniff',
    })
  );
  return new Response(method === 'HEAD' ? null : `Not found: ${pathname}\n`, {
    status: 404,
    headers,
  });
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const pathname = url.pathname;
  const origin = url.origin;

  // /game is routed separately to the game Worker on the canonical domain.
  if (pathname === '/game' || pathname.startsWith('/game/')) return next();

  // /openapi.json — serve the spec directly
  if (pathname === '/openapi.json') {
    const headers = withRateLimit(
      new Headers({
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
        'cache-control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
      })
    );
    return new Response(JSON.stringify(OPENAPI_SPEC, null, 2), { headers });
  }

  // Keep the documented sitemap URL as an alias for Astro's generated index.
  if (pathname === '/sitemap.xml' && (request.method === 'GET' || request.method === 'HEAD')) {
    const indexUrl = new URL('/sitemap-index.xml', url);
    const indexHeaders = new Headers();
    for (const name of ['accept', 'accept-encoding', 'if-none-match', 'if-modified-since']) {
      const value = request.headers.get(name);
      if (value) indexHeaders.set(name, value);
    }
    const indexRequest = new Request(indexUrl.toString(), {
      method: 'GET',
      headers: indexHeaders,
    });
    const indexResponse = await env.ASSETS.fetch(indexRequest);
    const contentType = indexResponse.headers.get('content-type');
    if (indexResponse.status === 200 && isXmlContentType(contentType)) {
      const headers = withRateLimit(new Headers(indexResponse.headers));
      if (request.method === 'HEAD') await indexResponse.body?.cancel();
      return new Response(request.method === 'HEAD' ? null : indexResponse.body, {
        status: 200,
        statusText: indexResponse.statusText,
        headers,
      });
    }

    if (indexResponse.status !== 200 && indexResponse.status !== 404) {
      return passThroughAssetError(indexResponse, request);
    }

    await indexResponse.body?.cancel();
    return new Response(request.method === 'HEAD' ? null : 'Sitemap not found.\n', {
      status: 404,
      headers: withRateLimit(
        new Headers({
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
      ),
    });
  }

  // JSON error for unknown /api/* paths (excluding /api/ai which is a static file)
  if (pathname.startsWith('/api/') && pathname !== '/api/ai') {
    return jsonError(404, 'not_found', `Unknown API path: ${pathname}`, pathname);
  }

  // Validate direct Markdown URLs too: Pages _headers can label its HTML SPA
  // fallback as Markdown before this middleware sees the response.
  if (
    (request.method === 'GET' || request.method === 'HEAD') &&
    pathname.endsWith('.md') &&
    !pathname.startsWith('/api/')
  ) {
    const markdownResponse = await fetchMarkdownAsset(env, url, request);
    if (markdownResponse.status >= 500) return passThroughAssetError(markdownResponse, request);
    if (markdownResponse.status === 404) {
      await markdownResponse.body?.cancel();
      return markdown404(pathname.slice(0, -3) || '/', origin, request.method);
    }
    if (markdownResponse.status !== 200) return passThroughAssetError(markdownResponse, request);
    const checked = await inspectMarkdown(markdownResponse);
    if (!checked.isMarkdown)
      return markdown404(pathname.slice(0, -3) || '/', origin, request.method);
    const headers = withRateLimit(new Headers(markdownResponse.headers));
    if (request.method === 'HEAD') await checked.body?.cancel();
    return new Response(request.method === 'HEAD' ? null : checked.body, {
      status: 200,
      statusText: markdownResponse.statusText,
      headers,
    });
  }

  // Accept: text/markdown negotiation for HTML pages that have a .md alternate.
  if (
    (request.method === 'GET' || request.method === 'HEAD') &&
    !pathname.includes('.') &&
    !pathname.startsWith('/api/') &&
    wantsMarkdown(request)
  ) {
    const mdPath = markdownPathFor(pathname);
    const mdUrl = new URL(mdPath, url);
    const mdResp = await fetchMarkdownAsset(env, mdUrl, request);
    if (mdResp.status >= 500) return passThroughAssetError(mdResp, request);
    if (mdResp.status === 404) {
      await mdResp.body?.cancel();
      return markdown404(pathname, origin, request.method);
    }
    if (mdResp.status !== 200) return passThroughAssetError(mdResp, request);
    const checked = await inspectMarkdown(mdResp);
    if (checked.isMarkdown) {
      const headers = withRateLimit(new Headers(mdResp.headers));
      addVary(headers, 'Accept', 'Accept-Encoding');
      headers.set('x-content-type-options', 'nosniff');
      if (request.method === 'HEAD') await checked.body?.cancel();
      return new Response(request.method === 'HEAD' ? null : checked.body, {
        status: 200,
        headers,
      });
    }

    // Pages' SPA fallback can return homepage HTML with a misleading Markdown
    // content type. The bounded body-prefix check rejects that false alternate.
    return markdown404(pathname, origin, request.method);
  }

  // Pass through to static assets first — only intercept 404s after.
  const response = await next();

  // Agent-friendly 404: markdown body for Accept: text/markdown on non-asset, non-API paths.
  if (response.status === 404 && !pathname.startsWith('/api/') && !pathname.includes('.')) {
    if (wantsMarkdown(request)) {
      return markdown404(pathname, origin, request.method);
    }
    const headers = withRateLimit(new Headers(response.headers));
    addVary(headers, 'Accept', 'Accept-Encoding');
    return new Response(request.method === 'HEAD' ? null : response.body, { status: 404, headers });
  }

  // Pages can serve its SPA homepage as a successful fallback for unknown
  // extensionless URLs. A real Markdown alternate identifies the page without
  // hardcoding route names; new agent-facing pages add their .md beside the HTML.
  if (
    response.status === 200 &&
    (request.method === 'GET' || request.method === 'HEAD') &&
    !pathname.startsWith('/api/') &&
    !pathname.includes('.') &&
    (response.headers.get('content-type') || '').toLowerCase().includes('text/html')
  ) {
    const alternateUrl = new URL(markdownPathFor(pathname), url);
    const alternate = await fetchMarkdownAsset(env, alternateUrl, request);
    if (alternate.status >= 500) {
      await response.body?.cancel();
      return passThroughAssetError(alternate, request);
    }
    if (alternate.status === 404) {
      await alternate.body?.cancel();
      await response.body?.cancel();
      return notFound(pathname, request.method);
    }
    if (alternate.status !== 200) {
      await response.body?.cancel();
      return passThroughAssetError(alternate, request);
    }
    const checked = await inspectMarkdown(alternate);
    if (!checked.isMarkdown) {
      await response.body?.cancel();
      return notFound(pathname, request.method);
    }
    await checked.body?.cancel();
  }

  // Add Vary: Accept to HTML responses that have markdown alternates
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    const headers = withRateLimit(new Headers(response.headers));
    addVary(headers, 'Accept', 'Accept-Encoding');
    if (request.method === 'HEAD') await response.body?.cancel();
    return new Response(request.method === 'HEAD' ? null : response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  // Add rate-limit headers to all other responses.
  const headers = withRateLimit(new Headers(response.headers));
  if (request.method === 'HEAD') await response.body?.cancel();
  return new Response(request.method === 'HEAD' ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
