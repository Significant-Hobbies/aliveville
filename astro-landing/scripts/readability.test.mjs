import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { documents, renderMarkdown, handleReadability, origin, robots } from '../src/lib/readability.mjs';
const request = (path, options) => handleReadability(new Request(origin + path, options));
test('all shared visible copy and links appear in their public mirror', async () => {
  assert.equal(documents.length, 4);
  for (const document of documents) {
    const body = renderMarkdown(document);
    for (const value of Object.values(document.text)) assert.ok(body.includes(value.replace(/\s+/g, ' ').trim()), `${document.path}: ${value}`);
    for (const link of Object.values(document.links)) assert.ok(body.includes(/^[a-z][a-z0-9+.-]*:/i.test(link) ? link : new URL(link, origin + document.path).href));
    const file = document.path === '/' ? 'index' : document.path.slice(1);
    const source = await readFile(new URL(`../src/pages/${file}.astro`, import.meta.url), 'utf8');
    for (const key of Object.keys(document.text)) assert.ok(source.includes(`copy.text.${key}`), `${document.path} HTML missing ${key}`);
    assert.doesNotMatch(body, /CORE_LOAD_84|NEURAL_NET_ACTIVE|\{\{text/);
  }
});
test('direct, suffix and negotiated Markdown share canonical content and transport contract', async () => {
  for (const document of documents) {
    const suffix = document.path === '/' ? '/index.md' : document.path + '.md';
    const response = await request(suffix);
    const body = await response.text();
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-location'), origin + document.path);
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, follow');
    for (const [path, headers] of [[document.path, { accept: 'text/markdown' }], ['/api/md' + document.path, {}]]) assert.equal(await (await request(path, { headers })).text(), body);
    assert.equal(await (await request(suffix, { method: 'HEAD' })).text(), '');
  }
  for (const accept of ['*/*', 'text/markdown;q=0', 'text/markdown, text/html']) assert.equal(await request('/', { headers: { accept } }), null);
  assert.equal((await request('/api/md', { method: 'OPTIONS' })).status, 204);
});
test('game/session/private paths stay outside discovery and all six crawlers allow public pages', async () => {
  const catalog = await (await request('/api/md/_catalog')).json();
  assert.deepEqual(catalog.map((route) => route.path), documents.map((document) => document.path));
  assert.equal(await request('/game/', { headers: { accept: 'text/markdown' } }), null);
  for (const path of ['/game.md', '/missing.md', '/api/md/admin', '/api/md/game']) assert.equal((await request(path)).status, 404);
  for (const bot of ['GPTBot', 'ClaudeBot', 'Google-Extended', 'Applebot-Extended', 'CCBot', 'Bytespider']) assert.ok(robots().includes(`User-agent: ${bot}\nAllow: /`));
  assert.match(robots(), /Disallow: \/game/);
  const full = await (await request('/llms-full.txt')).text(); assert.match(full, /Included 4 of 4/); assert.ok(full.length < 500000);
});

test('unknown Markdown paths cannot advertise off-origin canonicals', async () => {
  const { createAgentSurfaceManifest } = await import('../src/lib/agent-surfaces/manifest.mjs');
  const { createAgentSurfaceHandler } = await import('../src/lib/agent-surfaces/handler.mjs');
  const fixtureOrigin = 'https://public.example';
  const manifest = createAgentSurfaceManifest({ name: 'Public fixture', url: fixtureOrigin, summary: 'Public fixture', pages: { '/': '# Public' } });
  const handler = createAgentSurfaceHandler({ manifest });
  for (const path of ['/api/md//evil.example/x', '//evil.example/x.md']) {
    const response = await handler(new Request(fixtureOrigin + path));
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('content-location'), fixtureOrigin + '//evil.example/x');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, follow');
    assert.ok(response.headers.get('link').includes(fixtureOrigin + '/llms.txt'));
  }
});
