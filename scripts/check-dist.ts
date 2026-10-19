// Entry for `npm run check:dist`; the checks live in check-dist-lib.ts.
import { checkDist, measureDist, releaseProblems, sizeReport } from './check-dist-lib.ts';

const release = process.env.RELEASE_COMMIT || undefined;
const root = new URL('../', import.meta.url);
const failures = [...checkDist(root, release), ...releaseProblems(root)];
if (failures.length > 0) {
  console.error(`dist check failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(
  'dist check passed: prerendered content and head, link previews and structured data, 404 page, robots.txt, ' +
    'sitemap.xml, referenced files, hashed assets, release rules, size budgets' +
    (release === undefined ? '' : `, release ${release}`),
);
console.log(sizeReport(measureDist(root)));
