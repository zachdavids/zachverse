// Entry for `npm run check:dist`; the checks live in check-dist-lib.ts.
import { checkDist } from './check-dist-lib.ts';

const failures = checkDist(new URL('../dist/', import.meta.url));
if (failures.length > 0) {
  console.error(`dist check failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('dist check passed: prerendered content, 404 page, robots.txt, sitemap.xml, hashed assets');
