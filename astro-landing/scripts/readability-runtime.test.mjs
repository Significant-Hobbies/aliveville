import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';

async function freePort() {
  const socket = createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

for (const product of ['aliveville']) {
  test(`${product}: actual Pages assets and middleware honor public Markdown contract`, {
    timeout: 60000,
  }, async () => {
    const port = await freePort();
    const inspectorPort = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    // Wrangler4.99 prefers the ancestor game's JSON config over this Pages TOML.
    // Isolate config discovery without copying source, assets or dependencies.
    const harness = await mkdtemp(join(tmpdir(), 'aliveville-readability-'));
    await symlink(resolve('functions'), join(harness, 'functions'), 'dir');
    await symlink(resolve('src'), join(harness, 'src'), 'dir');
    const server = spawn(
      process.execPath,
      [
        resolve('../node_modules/wrangler/bin/wrangler.js'),
        'pages',
        'dev',
        resolve('dist'),
        '--ip',
        '127.0.0.1',
        '--port',
        String(port),
        '--inspector-port',
        String(inspectorPort),
        '--compatibility-date',
        '2026-06-09',
        '--log-level',
        'error',
      ],
      { cwd: harness, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let logs = '';
    server.stdout.on('data', (chunk) => {
      logs += chunk;
    });
    server.stderr.on('data', (chunk) => {
      logs += chunk;
    });
    try {
      let ready = false;
      for (let n = 0; n < 100; n++) {
        try {
          const response = await fetch(`${origin}/robots.txt`);
          if (response.ok) {
            ready = true;
            break;
          }
        } catch {}
        if (server.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert.ok(ready, logs);
      for (const method of ['GET', 'HEAD']) {
        const response = await fetch(`${origin}/api/ai`, {
          method,
          headers: { accept: 'text/markdown, application/json' },
        });
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /application\/json/);
        if (method === 'GET') assert.ok((await response.json()).surfaces.length > 0);
        else assert.equal(await response.text(), '');
      }
      const catalogResponse = await fetch(`${origin}/api/md/_catalog`);
      assert.equal(catalogResponse.status, 200);
      const catalog = await catalogResponse.json();
      const samples = catalog;
      for (const route of samples) {
        const mdPath = new URL(route.md).pathname;
        const directPath = `/api/md${route.path}`;
        const htmlPage = await fetch(origin + route.path);
        assert.equal(htmlPage.status, 200);
        assert.match(htmlPage.headers.get('content-type'), /text\/html/);
        const suffix = await fetch(origin + mdPath);
        const text = await suffix.text();
        assert.equal(suffix.status, 200);
        assert.match(suffix.headers.get('content-type'), /^text\/markdown/);
        assert.equal(suffix.headers.get('content-location'), route.url);
        assert.equal(suffix.headers.get('x-robots-tag'), 'noindex, follow');
        assert.equal(suffix.headers.get('access-control-allow-origin'), '*');
        assert.ok(Number(suffix.headers.get('x-markdown-tokens')) > 0);
        assert.match(text, /^(# |---)/);
        for (const [path, accept] of [
          [directPath, undefined],
          [route.path, 'text/markdown'],
        ]) {
          const response = await fetch(origin + path, { headers: accept ? { accept } : {} });
          assert.equal(response.status, 200);
          assert.equal(await response.text(), text);
        }
        const head = await fetch(origin + mdPath, { method: 'HEAD' });
        assert.equal(await head.text(), '');
        for (const name of [
          'content-type',
          'content-location',
          'x-markdown-tokens',
          'x-robots-tag',
        ])
          assert.equal(head.headers.get(name), suffix.headers.get(name));
        const preflight = await fetch(origin + directPath, { method: 'OPTIONS' });
        assert.equal(preflight.status, 204);
        assert.match(preflight.headers.get('access-control-allow-methods'), /GET, HEAD, OPTIONS/);
      }
      for (const accept of [
        '*/*',
        'text/markdown;q=0',
        'text/markdown;q=0.5, text/html;q=1',
        'text/markdown, text/html',
      ]) {
        const html = await fetch(`${origin}/`, { headers: { accept } });
        assert.match(html.headers.get('content-type'), /text\/html/);
        assert.match(html.headers.get('link'), /llms-full.txt/);
      }
      for (const path of [
        '/missing.md',
        '/api/md/admin',
        '/api/md/dashboard',
        '/api/md/missing',
        '/api/md/game',
        '/game.md',
      ]) {
        const missing = await fetch(origin + path);
        assert.equal(missing.status, 404);
        assert.match(missing.headers.get('content-type'), /text\/markdown/);
      }
      const full = await (await fetch(`${origin}/llms-full.txt`)).text();
      assert.ok(full.length < 500000);
      const policy = await (await fetch(`${origin}/ai.txt`)).text();
      assert.ok(policy.includes('training: allowed on public pages only'));
      const robots = await (await fetch(`${origin}/robots.txt`)).text();
      for (const bot of [
        'GPTBot',
        'ClaudeBot',
        'Google-Extended',
        'Applebot-Extended',
        'CCBot',
        'Bytespider',
      ])
        assert.ok(robots.includes(`User-agent: ${bot}\nAllow: /`));
      console.log(
        JSON.stringify({
          product,
          routes: catalog.length,
          sampledRoutes: samples.map((route) => route.path),
          fullCharacters: full.length,
        })
      );
    } finally {
      try {
        process.kill(-server.pid, 'SIGTERM');
      } catch {}
      await new Promise((resolve) => {
        if (server.exitCode !== null) resolve();
        else server.once('exit', resolve);
      });
      execFileSync('/usr/bin/trash', [harness]);
    }
  });
}
