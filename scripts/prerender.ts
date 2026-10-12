// Renders each page to static HTML after `vite build` (client) and
// `vite build --ssr` (server entry) have run. See docs/adr/0001.
import { prerender } from './prerender-lib.ts';

await prerender(new URL('../', import.meta.url));
