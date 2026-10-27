import home from '../content/readable/index.json' with { type: 'json' };
import simulator from '../content/readable/ai-world-simulator.json' with { type: 'json' };
import privacy from '../content/readable/privacy.json' with { type: 'json' };
import terms from '../content/readable/terms.json' with { type: 'json' };
import { createAgentSurfaceManifest } from './agent-surfaces/manifest.mjs';
import { createAgentSurfaceHandler } from './agent-surfaces/handler.mjs';
import { absoluteMarkdownLinks } from './agent-surfaces/format.mjs';
export { advertiseMarkdown } from './agent-surfaces/adapters/static-assets.mjs';
export const origin = 'https://aliveville.com';
export const documents = [home, simulator, privacy, terms];
export function renderMarkdown(document) {
  const body = document.markdown
    .replace(/\{\{(text|links)\.([a-z0-9_]+)\}\}/g, (_, type, key) => {
      const value = document[type][key];
      if (typeof value !== 'string') throw new Error(`Missing public copy ${key}`);
      return value.replace(/\s+/g, ' ').trim();
    })
    .replace(/ +\]/g, ']');
  return `---\ntitle: ${JSON.stringify(document.title)}\ndescription: ${JSON.stringify(document.summary)}\ncanonical: ${origin}${document.path}\n---\n\n${absoluteMarkdownLinks(body, origin + document.path)}\nCanonical HTML: ${origin}${document.path}\n`;
}
export const routes = documents.map((document) => ({
  path: document.path,
  title: document.title,
  description: document.summary,
}));
const excludedPaths = ['/api', '/game', '/admin', '/auth', '/dashboard'];
export const manifest = createAgentSurfaceManifest({
  name: 'AliveVille',
  url: origin,
  summary: home.summary,
  contact: 'mailto:sarthakagrawal927@gmail.com',
  trainingAllowed: true,
  sitemap: origin + '/sitemap.xml',
  openapi: origin + '/openapi.json',
  excludedPaths,
  pages: Object.fromEntries(documents.map((document) => [document.path, renderMarkdown(document)])),
});
const handle = createAgentSurfaceHandler({ manifest, listMarkdownRoutes: () => routes });
export async function handleReadability(request) {
  const path = new URL(request.url).pathname;
  if (path === '/api/ai' || path === '/game' || path.startsWith('/game/')) return null;
  if (path === '/robots.txt' && ['GET', 'HEAD'].includes(request.method))
    return new Response(request.method === 'HEAD' ? null : robots(), {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
      },
    });
  return handle(request);
}
export function robots() {
  const bots = [
    '*',
    'GPTBot',
    'ClaudeBot',
    'Google-Extended',
    'Applebot-Extended',
    'CCBot',
    'Bytespider',
    'OAI-SearchBot',
    'ChatGPT-User',
    'Claude-SearchBot',
    'Claude-User',
    'PerplexityBot',
    'Perplexity-User',
  ];
  return (
    bots
      .map(
        (bot) =>
          `User-agent: ${bot}\nAllow: /\n${excludedPaths.map((path) => `Disallow: ${path}`).join('\n')}\nAllow: /api/ai$\nAllow: /api/md$\nAllow: /api/md/`
      )
      .join('\n\n') +
    `\n\nSitemap: ${origin}/sitemap.xml\n# Keep in sync with ai.txt and llms.txt.\n`
  );
}
