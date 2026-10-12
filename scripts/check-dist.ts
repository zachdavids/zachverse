// Entry for `npm run check:dist`; the checks live in check-dist-lib.ts.
import { checkDist } from './check-dist-lib.ts';

const failures = checkDist(new URL('../', import.meta.url));
if (failures.length > 0) {
  console.error(`dist check failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(
  'dist check passed: prerendered content and head, 404 page, robots.txt, sitemap.xml, referenced files, hashed assets',
);
