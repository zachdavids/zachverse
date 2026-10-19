// Lighthouse's lab measurements of the built pages, judged against the Phase 2 plan's targets (LCP at most 2.5 s, CLS
// at most 0.1, INP at most 200 ms) and Lighthouse's own scores, and reported. scripts/lighthouse.ts runs Lighthouse;
// these functions only read its results.

/** One audit's result: its score, from 0 to 1, and a metric's value, in milliseconds or, for CLS, unitless. */
interface Audit {
  score: number | null;
  scoreDisplayMode: string;
  numericValue?: number;
  errorMessage?: string;
}

/**
 * The parts of a Lighthouse result (its "lhr") the checks read. scripts/lighthouse.ts passes Lighthouse's own result
 * where this is expected, so tsc checks that it fits.
 */
export interface Lhr {
  /** Set when Lighthouse could not load or measure the page. */
  runtimeError?: { code: string; message: string };
  configSettings: { formFactor: string; throttlingMethod: string };
  /**
   * Each category's score, from 0 to 1, is the weighted mean of its audits' scores, rounded to two decimals, or null
   * when an audit that counts toward it could not run. An audit that doesn't apply to the page has a weight of 0.
   */
  categories: Record<string, { score: number | null; auditRefs: { id: string; weight: number }[] }>;
  audits: Record<string, Audit>;
}

/** What a run emulates: a phone, as Lighthouse's default settings do, or a desktop, as its desktop config does. */
export type FormFactor = 'mobile' | 'desktop';

/**
 * One Lighthouse run: the address of the page it loaded, the form factor it was started as, and its result, or, when
 * Lighthouse failed and gave none, its error.
 */
export type Run = { path: string; formFactor: FormFactor } & ({ lhr: Lhr } | { error: string });

export interface Result {
  passed: string[];
  failures: string[];
}

/** The categories every run must report, with the least score each may have, on Lighthouse's scale of 0 to 1. */
export const CATEGORIES = [
  // Lighthouse counts 0.9 and above as good. The score moves a little from run to run, and the metrics below hold the
  // plan's targets themselves, so this catches what they don't, such as a slow speed index.
  { id: 'performance', title: 'Performance', min: 0.9 },
  // Audits of what each page's markup, scripts, and headers control, which pass or fail the same way on every run, so
  // any that fails is a fault in the page rather than a slow run.
  { id: 'accessibility', title: 'Accessibility', min: 1 },
  { id: 'best-practices', title: 'Best practices', min: 1 },
  { id: 'seo', title: 'SEO', min: 1 },
] as const;

/**
 * The metrics every run must report, with the most each may measure, for both form factors. The LCP and CLS limits are
 * the plan's targets, which web.dev counts as good at the 75th percentile of real visits; here each holds for one
 * simulated load. Values are compared as the table shows them, in whole milliseconds and CLS to three decimals, so the
 * table never shows a value that failed as within its limit.
 */
const METRICS = [
  { id: 'largest-contentful-paint', label: 'LCP', max: 2500, unit: ' ms', decimals: 0 },
  { id: 'cumulative-layout-shift', label: 'CLS', max: 0.1, unit: '', decimals: 3 },
  // INP needs a visitor's interactions, which a lab load doesn't make: Lighthouse measures it only over a timespan with
  // interactions in it, never in a page load like these. Total blocking time, the long tasks that would delay a
  // response to input while the page loads, stands in for it, at INP's target of 200 ms, which Lighthouse also counts
  // as good TBT on a phone.
  { id: 'total-blocking-time', label: 'TBT', max: 200, unit: ' ms', decimals: 0 },
  // Reported, with no limit of its own: how soon the page first shows anything.
  { id: 'first-contentful-paint', label: 'FCP', max: null, unit: ' ms', decimals: 0 },
] as const;

// A score as Lighthouse's report shows it, out of 100.
const points = (score: number) => String(Math.round(score * 100));

// A metric's value as the table shows it, and as it is compared with its limit.
const shown = (value: number, decimals: number) => Number(value.toFixed(decimals));

/** Problems with one run's result. */
export function runProblems(run: Run): string[] {
  // Lighthouse failed, so there is no result to read.
  if ('error' in run) return [run.error];
  const { formFactor, lhr } = run;
  const { runtimeError, configSettings: settings } = lhr;
  // Lighthouse could not load or measure the page, so nothing else in the result describes it.
  if (runtimeError) return [`Lighthouse could not measure the page (${runtimeError.code}): ${runtimeError.message}`];
  const problems: string[] = [];
  // The report names each run by the form factor it was started as, and the limits assume simulated throttling, which
  // models a slow network and CPU from an unthrottled load; another method would measure this machine's own.
  if (settings.formFactor !== formFactor) {
    problems.push(`Lighthouse emulated ${settings.formFactor}, not ${formFactor}`);
  }
  if (settings.throttlingMethod !== 'simulate') {
    problems.push(`Lighthouse's throttling method was ${settings.throttlingMethod}, not simulate`);
  }
  // A category or audit that is missing, as one renamed in a later Lighthouse would be, fails the run rather than
  // passing unread.
  for (const { id, min } of CATEGORIES) {
    const category = lhr.categories[id];
    if (category === undefined) {
      problems.push(`Lighthouse reported no ${id} category`);
      continue;
    }
    // A score of 1 means every audit that counts toward it passed, but Lighthouse rounds the score to two decimals,
    // which can hide a failed audit of little weight. So for a category that must score 1, each audit that failed or
    // could not run is found and named.
    const failed =
      min === 1 ? category.auditRefs.filter((ref) => ref.weight > 0 && lhr.audits[ref.id]?.score !== 1) : [];
    const { score } = category;
    if (score !== null && score >= min && failed.length === 0) continue;
    const below = score !== null && score < min ? `, below ${points(min)}` : '';
    const scored = score === null ? 'has no score' : `scored ${points(score)}${below}`;
    const audits = failed.length === 0 ? '' : `: ${failed.map((ref) => ref.id).join(', ')} did not pass`;
    problems.push(`${id} ${scored}${audits}`);
  }
  for (const { id, label, max, unit, decimals } of METRICS) {
    const audit = lhr.audits[id];
    if (audit === undefined) {
      problems.push(`Lighthouse reported no ${id} audit`);
    } else if (audit.numericValue === undefined) {
      const reason = audit.errorMessage === undefined ? '' : `: ${audit.errorMessage}`;
      problems.push(`Lighthouse measured no ${label} (${audit.scoreDisplayMode})${reason}`);
    } else if (max !== null && shown(audit.numericValue, decimals) > max) {
      problems.push(`${label} ${shown(audit.numericValue, decimals)}${unit}, over ${max}${unit}`);
    }
  }
  return problems;
}

/** The runs within every limit, and each problem with the others, each named by its page and form factor. */
export function lighthouseCheck(runs: Run[]): Result {
  const passed: string[] = [];
  const failures: string[] = [];
  for (const run of runs) {
    const name = `${run.path} (${run.formFactor})`;
    const problems = runProblems(run);
    if (problems.length === 0) passed.push(name);
    else failures.push(...problems.map((problem) => `${name}: ${problem}`));
  }
  return { passed, failures };
}

/**
 * The runs as a markdown table, each one's scores and metrics under a row of the limits, after a note that says what
 * they are: lab results, not field data. A value the result lacks shows as a dash, as does every value of a run that
 * failed; runProblems reports each.
 */
export function report(runs: Run[]): string[] {
  const row = (cells: string[]) => `| ${cells.join(' | ')} |`;
  const header = ['Page', 'Form factor', ...CATEGORIES.map(({ title }) => title), ...METRICS.map(({ label }) => label)];
  const limits = [
    'Limit',
    '',
    ...CATEGORIES.map(({ min }) => (min === 1 ? '100' : `≥ ${points(min)}`)),
    ...METRICS.map(({ max, unit }) => (max === null ? '' : `≤ ${max}${unit}`)),
  ];
  const measured = runs.map((run) => {
    const lhr = 'lhr' in run ? run.lhr : undefined;
    return [
      run.path,
      run.formFactor,
      ...CATEGORIES.map(({ id }) => {
        const score = lhr?.categories[id]?.score ?? null;
        return score === null ? '—' : points(score);
      }),
      ...METRICS.map(({ id, unit, decimals }) => {
        const value = lhr?.audits[id]?.numericValue;
        return value === undefined ? '—' : `${shown(value, decimals)}${unit}`;
      }),
    ];
  });
  return [
    'Lab results, not field data: one Lighthouse load of each page per form factor, with simulated throttling, from ' +
      "a local server that compresses files as CloudFront does. Visitors' devices and networks vary, and Lighthouse " +
      "doesn't measure INP, which needs a visitor's interactions; TBT stands in for it.",
    '',
    row(header),
    row(header.map((_, i) => (i < 2 ? '---' : '---:'))),
    row(limits),
    ...measured.map(row),
  ];
}
