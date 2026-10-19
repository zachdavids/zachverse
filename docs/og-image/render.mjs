// Renders public/og-image.png, the picture link previews show for every page (ADR 0010, "Preview picture"): Phase 1's
// card at Open Graph's 1200 x 630, with the name and role from src/content/profile.ts, the domain from
// src/content/site.ts, and the light palette from src/styles.css. From the repository root, after npm ci and
// `npx playwright install --only-shell chromium`:
//
//   node docs/og-image/render.mjs
//
// The fonts are the machine's: the committed picture was rendered on Windows, in Segoe UI. It runs Playwright, a
// project package, so it refuses to start while an AWS CLI session is live (ADR 0004, "Administrative access").
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { profile } from '../../src/content/profile.ts';
import { site } from '../../src/content/site.ts';

const loginCache = join(homedir(), '.aws', 'login', 'cache');
if (existsSync(loginCache) && readdirSync(loginCache).length > 0) {
  console.error('An AWS session is live (~/.aws/login/cache is not empty); end it with `aws logout --all` first.');
  process.exit(1);
}

// The stylesheet's first :root rule holds the light palette; the dark one follows inside a media query.
const styles = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');
const light = /:root\s*\{([^}]*)\}/.exec(styles)?.[1] ?? '';
const colour = (name) => {
  const value = new RegExp(`--${name}:\\s*([^;]+);`).exec(light)?.[1]?.trim();
  if (value === undefined) throw new Error(`src/styles.css's first :root rule sets no --${name}`);
  return value;
};

const out = fileURLToPath(new URL('../../public/og-image.png', import.meta.url));
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><style>
  html, body { margin: 0; }
  body {
    width: 1200px; height: 630px; display: grid; place-items: center; background: ${colour('bg')};
    color: ${colour('fg')};
    font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  }
  .card {
    box-sizing: border-box; width: 1040px; padding: 72px 80px; border: 2px solid ${colour('border')};
    border-radius: 32px; background: ${colour('card')};
  }
  h1 { margin: 0; font-size: 104px; line-height: 1.05; letter-spacing: -0.02em; }
  .role { margin: 26px 0 0; font-size: 46px; line-height: 1.2; }
  .site { margin: 44px 0 0; color: ${colour('accent')}; font-size: 30px; font-weight: 600; }
</style><main class="card"><h1>${profile.name}</h1>
<p class="role">${profile.role}</p><p class="site">${new URL(site.origin).host}</p></main></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: out, type: 'png' });
  console.log(`wrote public/og-image.png (${statSync(out).size} bytes)`);
} finally {
  await browser.close();
}
