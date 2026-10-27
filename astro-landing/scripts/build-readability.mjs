import { writeFile, readFile, readdir } from 'node:fs/promises';
import { documents, renderMarkdown, handleReadability, origin, robots } from '../src/lib/readability.mjs';
const output = new URL('../dist/', import.meta.url);
const catalog = JSON.parse(await readFile(new URL('../public/api-ai.json', import.meta.url), 'utf8'));
if (catalog.surfaces.length !== documents.length || catalog.surfaces.some((entry) => !documents.some((document) => origin + document.path === entry.url))) throw new Error('Legacy catalog/public source registry mismatch');
await writeFile(new URL('api-ai.json', output), JSON.stringify(catalog, null, 2) + '\n');
for (const document of documents) {
  const name = document.path === '/' ? 'index' : document.path.slice(1);
  const html = await readFile(new URL(`${name}.html`, output), 'utf8');
  if (!html.includes('name="ai-summary"') || !html.includes('type="text/markdown"')) throw new Error(`Missing head signals: ${name}`);
  await writeFile(new URL(`${name}.md`, output), renderMarkdown(document));
}
const htmlFiles = (await readdir(output)).filter((name) => name.endsWith('.html') && name !== '404.html');
if (htmlFiles.length !== documents.length) throw new Error('Public HTML/Markdown registry mismatch');
for (const file of ['llms.txt', 'llms-full.txt', 'ai.txt']) {
  const response = await handleReadability(new Request(`${origin}/${file}`));
  if (!response?.ok) throw new Error(`Cannot generate ${file}`);
  await writeFile(new URL(file, output), await response.text());
}
await writeFile(new URL('robots.txt', output), robots());
await writeFile(new URL('sitemap.xml', output), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${documents.map((document) => `<url><loc>${origin}${document.path}</loc></url>`).join('')}</urlset>\n`);
console.log(`Generated ${documents.length} complete public Markdown mirrors; game/session routes excluded.`);
