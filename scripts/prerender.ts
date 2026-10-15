// Renders each page to static HTML after `vite build` (client) and
// `vite build --ssr` (server entry) have run. See docs/adr/0001. The deploy
// build sets RELEASE_COMMIT, and the pages then name it (ADR 0006).
import { prerender } from './prerender-lib.ts';

await prerender(new URL('../', import.meta.url), process.env.RELEASE_COMMIT || undefined);
