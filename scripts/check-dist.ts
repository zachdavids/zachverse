// Entry for `npm run check:dist`; the checks live in check-dist-lib.ts.
import { checkDist } from './check-dist-lib.ts';

const release = process.env.RELEASE_COMMIT || undefined;
const failures = checkDist(new URL('../', import.meta.url), release);
if (failures.length > 0) {
  console.error(`dist check failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(
  'dist check passed: prerendered content and head, 404 page, robots.txt, sitemap.xml, referenced files, hashed assets' +
    (release === undefined ? '' : `, release ${release}`),
);
