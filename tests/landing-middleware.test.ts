import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const middlewareSource = await readFile(
  new URL('../astro-landing/functions/_middleware.ts', import.meta.url),
  'utf8'
);
const middlewareJavaScript = ts.transpileModule(middlewareSource, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const { onRequest } = await import(
  `data:text/javascript;base64,${Buffer.from(middlewareJavaScript).toString('base64')}`
);

type Context = Parameters<typeof onRequest>[0];

function makeContext(options: {
  path: string;
  accept?: string;
  headers?: HeadersInit;
  method?: 'GET' | 'HEAD';
  asset: (request: Request) => Promise<Response> | Response;
  next?: () => Promise<Response> | Response;
}) {
  const assetFetch = vi.fn(options.asset);
  const next = vi.fn(
    options.next ??
      (() =>
        new Response('<html>page</html>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }))
  );
  const headers = new Headers(options.headers);
  if (options.accept) headers.set('accept', options.accept);
  const context = {
    request: new Request(`https://aliveville.com${options.path}`, {
      method: options.method ?? 'GET',
      headers,
    }),
    env: { ASSETS: { fetch: assetFetch } },
    next,
  } as unknown as Context;
  return { context, assetFetch, next };
}

describe('AliveVille landing Pages middleware', () => {
  it('serves the documented sitemap alias from Astro’s XML index', async () => {
    const asset = vi.fn((request: Request) => {
      expect(new URL(request.url).pathname).toBe('/sitemap-index.xml');
      return new Response('<sitemapindex></sitemapindex>', {
        headers: { 'content-type': 'application/xml; charset=utf-8' },
      });
    });

    const { context, assetFetch } = makeContext({ path: '/sitemap.xml', asset });
    const response = await onRequest(context);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/xml');
    expect(response.headers.get('ratelimit-limit')).toBe('60');
    expect(await response.text()).toContain('<sitemapindex>');
    expect(assetFetch).toHaveBeenCalledOnce();
  });

  it('preserves HEAD on the sitemap alias and rejects an HTML Pages fallback', async () => {
    const headAssetResponse = new Response('<sitemapindex></sitemapindex>', {
      headers: { 'content-type': 'application/xml' },
    });
    const headRequest = vi.fn((request: Request) => {
      expect(request.method).toBe('GET');
      return headAssetResponse;
    });
    const { context } = makeContext({ path: '/sitemap.xml', method: 'HEAD', asset: headRequest });
    const head = await onRequest(context);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(headAssetResponse.bodyUsed).toBe(true);

    const invalidXml = new Response('<html>home</html>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
    const { context: missingContext } = makeContext({
      path: '/sitemap.xml',
      asset: () => invalidXml,
    });
    const missing = await onRequest(missingContext);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toContain('text/plain');
    expect(invalidXml.bodyUsed).toBe(true);
  });

  it('preserves conditional and throttled sitemap asset responses', async () => {
    const { context } = makeContext({
      path: '/sitemap.xml',
      headers: { 'if-none-match': '"sitemap-v1"' },
      asset: (request) => {
        expect(request.headers.get('if-none-match')).toBe('"sitemap-v1"');
        return new Response(null, { status: 304, headers: { etag: '"sitemap-v1"' } });
      },
    });
    const notModified = await onRequest(context);
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get('etag')).toBe('"sitemap-v1"');
    expect(await notModified.text()).toBe('');

    const { context: throttledContext } = makeContext({
      path: '/sitemap.xml',
      asset: () =>
        new Response('rate limited', {
          status: 429,
          headers: { 'retry-after': '30' },
        }),
    });
    const throttled = await onRequest(throttledContext);
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('retry-after')).toBe('30');
    expect(await throttled.text()).toBe('rate limited');
  });

  it.each([
    ['/', '/index.md'],
    ['/privacy', '/privacy.md'],
    ['/terms', '/terms.md'],
    ['/ai-world-simulator', '/ai-world-simulator.md'],
  ])('negotiates the real Markdown alternate for %s', async (path, markdownPath) => {
    const asset = vi.fn((request: Request) => {
      expect(new URL(request.url).pathname).toBe(markdownPath);
      return new Response(`# ${path} Markdown`, {
        headers: { 'content-type': 'text/markdown; charset=utf-8' },
      });
    });
    const { context } = makeContext({ path, accept: 'text/markdown', asset });
    const response = await onRequest(context);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/markdown');
    expect(response.headers.get('vary')).toBe('Accept, Accept-Encoding');
    expect(response.headers.get('ratelimit-limit')).toBe('60');
    expect(await response.text()).toContain('Markdown');
  });

  it('returns a Markdown 404 when the requested alternate falls back to HTML', async () => {
    const asset = vi.fn(
      () =>
        new Response('<!doctype html><html>SPA fallback</html>', {
          headers: { 'content-type': 'text/markdown; charset=utf-8' },
        })
    );
    const { context, next } = makeContext({
      path: '/does-not-exist',
      accept: 'text/markdown',
      asset,
    });
    const response = await onRequest(context);

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('text/markdown');
    expect(response.headers.get('vary')).toBe('Accept, Accept-Encoding');
    expect(await response.text()).toContain('does not exist');
    expect(next).not.toHaveBeenCalled();
  });

  it('replays large streamed Markdown completely after inspecting its prefix', async () => {
    const tail = new TextEncoder().encode('\nDelayed final paragraph.');
    const asset = vi.fn(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode(`# Large page\n${'body '.repeat(300)}`));
              await new Promise((resolve) => setTimeout(resolve, 5));
              controller.enqueue(tail);
              controller.close();
            },
          }),
          {
            headers: { 'content-type': 'text/markdown; charset=utf-8' },
          }
        )
    );
    const { context } = makeContext({ path: '/large', accept: 'text/markdown', asset });
    const response = await onRequest(context);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('body '.repeat(300));
    expect(body.endsWith('Delayed final paragraph.')).toBe(true);
  });

  it('keeps HEAD responses bodyless for real and missing Markdown alternates', async () => {
    const real = makeContext({
      path: '/privacy',
      method: 'HEAD',
      accept: 'text/markdown',
      asset: () =>
        new Response('# Privacy', {
          headers: { 'content-type': 'text/markdown; charset=utf-8' },
        }),
    });
    const realResponse = await onRequest(real.context);
    expect(realResponse.status).toBe(200);
    expect(realResponse.headers.get('content-type')).toContain('text/markdown');
    expect(await realResponse.text()).toBe('');

    const missing = makeContext({
      path: '/not-here',
      method: 'HEAD',
      accept: 'text/markdown',
      asset: () =>
        new Response('<html>SPA fallback</html>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    });
    const missingResponse = await onRequest(missing.context);
    expect(missingResponse.status).toBe(404);
    expect(missingResponse.headers.get('content-type')).toContain('text/markdown');
    expect(await missingResponse.text()).toBe('');
  });

  it('checks explicit .md URLs with a GET probe and rejects mislabeled homepage HTML', async () => {
    const asset = vi.fn((request: Request) => {
      expect(request.method).toBe('GET');
      return new Response('<!doctype html><html>SPA fallback</html>', {
        headers: { 'content-type': 'text/markdown; charset=utf-8' },
      });
    });
    const { context } = makeContext({ path: '/unknown.md', method: 'HEAD', asset });
    const response = await onRequest(context);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('text/markdown');
    expect(await response.text()).toBe('');
  });

  it.each([429, 500, 503])('preserves upstream alternate errors with status %i', async (status) => {
    const { context } = makeContext({
      path: '/privacy',
      accept: 'text/markdown',
      asset: () =>
        new Response('upstream failure', {
          status,
          headers: { 'content-type': 'text/plain', vary: 'Accept-Encoding' },
        }),
    });
    const response = await onRequest(context);
    expect(response.status).toBe(status);
    expect(response.headers.get('vary')).toBe('Accept-Encoding, Accept');
    expect(await response.text()).toBe('upstream failure');
  });

  it('returns a plain 404 for unknown HTML paths despite the Pages homepage fallback', async () => {
    const { context, next } = makeContext({
      path: '/missing-html-page',
      accept: 'text/html',
      asset: () =>
        new Response('<!doctype html><html>SPA fallback</html>', {
          headers: { 'content-type': 'text/markdown; charset=utf-8' },
        }),
      next: () =>
        new Response('<html>SPA fallback</html>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    });
    const response = await onRequest(context);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toContain('missing-html-page');
    expect(next).toHaveBeenCalledOnce();
  });

  it('keeps future extensionless HTML routes when they have a Markdown alternate', async () => {
    const { context } = makeContext({
      path: '/future-agent-page',
      accept: 'text/html',
      asset: () =>
        new Response('# Future page', {
          headers: { 'content-type': 'text/markdown; charset=utf-8' },
        }),
      next: () =>
        new Response('<html>Future page</html>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    });
    const response = await onRequest(context);

    expect(response.status).toBe(200);
    expect(response.headers.get('vary')).toContain('Accept');
    expect(await response.text()).toContain('Future page');
  });

  it('preserves upstream errors while checking whether an HTML route exists', async () => {
    const { context } = makeContext({
      path: '/temporarily-unavailable',
      accept: 'text/html',
      asset: () =>
        new Response('rate limited', {
          status: 429,
          headers: { 'content-type': 'text/plain', vary: 'Accept-Encoding' },
        }),
      next: () =>
        new Response('<html>Page</html>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    });
    const response = await onRequest(context);

    expect(response.status).toBe(429);
    expect(response.headers.get('vary')).toBe('Accept-Encoding, Accept');
    expect(await response.text()).toBe('rate limited');
  });

  it('keeps sequential HTML and Markdown representations varied by Accept', async () => {
    const html = makeContext({
      path: '/',
      accept: 'text/html',
      asset: () =>
        new Response('# Markdown', {
          headers: { 'content-type': 'text/markdown; charset=utf-8' },
        }),
      next: () =>
        new Response('<html>HTML page</html>', {
          headers: { 'content-type': 'text/html; charset=utf-8', vary: 'Accept-Encoding' },
        }),
    });
    const htmlResponse = await onRequest(html.context);
    expect(htmlResponse.status).toBe(200);
    expect(htmlResponse.headers.get('vary')).toBe('Accept-Encoding, Accept');
    expect(await htmlResponse.text()).toContain('HTML page');
    expect(html.assetFetch).toHaveBeenCalledOnce();

    const markdown = makeContext({
      path: '/',
      accept: 'text/markdown',
      asset: () =>
        new Response('# Markdown', {
          headers: {
            'content-type': 'text/markdown; charset=utf-8',
            vary: 'accept, ACCEPT-Encoding',
          },
        }),
    });
    const markdownResponse = await onRequest(markdown.context);
    expect(markdownResponse.status).toBe(200);
    expect(markdownResponse.headers.get('vary')).toBe('accept, ACCEPT-Encoding');
    expect(await markdownResponse.text()).toContain('# Markdown');
  });

  it('preserves wildcard Vary without appending redundant selectors', async () => {
    const { context } = makeContext({
      path: '/',
      accept: 'text/html',
      asset: () =>
        new Response('# Markdown', {
          headers: { 'content-type': 'text/markdown; charset=utf-8' },
        }),
      next: () =>
        new Response('<html>HTML page</html>', {
          headers: { 'content-type': 'text/html; charset=utf-8', vary: '*' },
        }),
    });
    const response = await onRequest(context);
    expect(response.status).toBe(200);
    expect(response.headers.get('vary')).toBe('*');
  });

  it('passes /game routes through untouched for the separately routed Worker', async () => {
    const { context, assetFetch, next } = makeContext({
      path: '/game/',
      accept: 'text/markdown',
      asset: () => new Response('unused'),
      next: () =>
        new Response('<html>Game Worker</html>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    });
    const response = await onRequest(context);
    expect(response.status).toBe(200);
    expect(response.headers.get('ratelimit-limit')).toBeNull();
    expect(await response.text()).toContain('Game Worker');
    expect(assetFetch).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('returns 404 when the sitemap index asset falls back to HTML', async () => {
    const { context } = makeContext({
      path: '/sitemap.xml',
      asset: () =>
        new Response('<html>SPA fallback</html>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    });
    const response = await onRequest(context);
    expect(response.status).toBe(404);
  });

  it('keeps unknown API routes on their JSON 404 contract', async () => {
    const { context, assetFetch, next } = makeContext({
      path: '/api/missing',
      accept: 'text/markdown',
      asset: () => new Response('unused'),
    });
    const response = await onRequest(context);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
    expect(assetFetch).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});
