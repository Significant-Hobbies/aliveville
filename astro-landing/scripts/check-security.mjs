import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import config from '../astro.config.mjs';
import { validateAudit } from './security-policy.mjs';

// Keep the unfiltered audit visible and preserve the reviewed static boundary.
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(
  manifest.dependencies.astro,
  '7.3.6',
  'Re-check the pinned cache patch and static Pages boundary when changing Astro'
);
assert.equal(config.output, 'static', 'The reviewed Pages boundary requires a static landing');
assert.equal(
  config.adapter,
  undefined,
  'An Astro runtime adapter requires a fresh security review'
);
assert.equal(
  config.image?.domains?.length ?? 0,
  0,
  'Remote image optimization requires a fresh review'
);
assert.equal(
  config.image?.remotePatterns?.length ?? 0,
  0,
  'Remote image optimization requires a fresh review'
);

async function checkSources(directory, functions = false) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = new URL(entry.name, directory);
    if (entry.isDirectory()) {
      await checkSources(new URL(`${entry.name}/`, directory), functions);
    } else if (/\.(astro|[cm]?js|[cm]?ts|tsx|jsx)$/.test(entry.name)) {
      const text = await readFile(path, 'utf8');
      assert(
        !text.includes('astro:assets'),
        `${path.pathname}: image optimization requires a fresh review`
      );
      assert(
        !/prerender\s*=\s*false/.test(text),
        `${path.pathname}: dynamic rendering requires a fresh review`
      );
      if (functions) {
        assert(
          !/(?:from\s*|import\s*\(|require\s*\()\s*['"](?:astro(?:\/|['"])|http-cache-semantics)/.test(
            text
          ),
          `${path.pathname}: Pages Functions must remain independent of Astro/cache policy`
        );
      }
    }
  }
}
await checkSources(new URL('../src/', import.meta.url));
await checkSources(new URL('../functions/', import.meta.url), true);

const result = spawnSync('pnpm', ['audit', '--json'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024,
});
if (result.error) throw result.error;
if (result.stderr) process.stderr.write(result.stderr);
process.stdout.write(result.stdout);
const audit = JSON.parse(result.stdout);
validateAudit(audit, result.status);
console.log('No installed dependency advisories. Static landing security boundary passed.');
