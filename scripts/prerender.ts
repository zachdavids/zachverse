// Renders each page to static HTML after `vite build` (client) and
// `vite build --ssr` (server entry) have run. See docs/adr/0001.
import { readFile, rm, writeFile } from 'node:fs/promises';
import { prerenderPages, renderDocument } from './prerender-lib.ts';

const rootDir = new URL('../', import.meta.url);
const distDir = new URL('dist/', rootDir);
const ssrDir = new URL('dist-ssr/', rootDir);

const template = await readFile(new URL('index.html', distDir), 'utf8');
const { render } = (await import(new URL('entry-server.js', ssrDir).href)) as {
  render: (page: string) => string;
};

for (const page of prerenderPages) {
  await writeFile(new URL(page.file, distDir), renderDocument(template, page, render(page.id)));
  console.log(`prerendered ${page.id} -> dist/${page.file}`);
}

await rm(ssrDir, { recursive: true, force: true });
