import { describe, expect, it } from 'vitest';
import { type FormFactor, type Lhr, lighthouseCheck, report, type Run, runProblems } from './lighthouse-lib.ts';

// A metric's audit, as Lighthouse gives it: the value measured, and the score it earned.
const metric = (numericValue: number, score = 1) => ({ score, scoreDisplayMode: 'numeric', numericValue });
// An audit that passed, or failed.
const binary = (score = 1) => ({ score, scoreDisplayMode: 'binary' });

// A result within every limit, shaped as Lighthouse 13 gives one for the built pages: each category with audits that
// count toward its score, and some that don't, which Lighthouse gives a weight of 0.
const goodLhr = (formFactor: FormFactor): Lhr => ({
  configSettings: { formFactor, throttlingMethod: 'simulate' },
  categories: {
    performance: {
      score: 0.99,
      auditRefs: [
        { id: 'first-contentful-paint', weight: 10 },
        { id: 'largest-contentful-paint', weight: 25 },
        { id: 'total-blocking-time', weight: 30 },
        { id: 'cumulative-layout-shift', weight: 25 },
        { id: 'speed-index', weight: 10 },
        { id: 'interactive', weight: 0 },
      ],
    },
    accessibility: {
      score: 1,
      auditRefs: [
        { id: 'color-contrast', weight: 7 },
        { id: 'image-alt', weight: 10 },
        // It applies only to SVG images, which the page has none of.
        { id: 'svg-img-alt', weight: 0 },
      ],
    },
    'best-practices': {
      score: 1,
      auditRefs: [
        { id: 'is-on-https', weight: 5 },
        { id: 'errors-in-console', weight: 1 },
      ],
    },
    seo: {
      score: 1,
      auditRefs: [
        { id: 'is-crawlable', weight: 93 / 23 },
        { id: 'document-title', weight: 1 },
      ],
    },
  },
  audits: {
    'first-contentful-paint': metric(1598.182, 0.94),
    'largest-contentful-paint': metric(1598.182, 0.99),
    'total-blocking-time': metric(0),
    'cumulative-layout-shift': metric(0),
    'speed-index': metric(1598.182),
    interactive: metric(1598.182),
    'color-contrast': binary(),
    'image-alt': binary(),
    'svg-img-alt': { score: null, scoreDisplayMode: 'notApplicable' },
    'is-on-https': binary(),
    'errors-in-console': binary(),
    'is-crawlable': binary(),
    'document-title': binary(),
  },
});

// A run of path, started as formFactor, whose result is the good one with change made to it.
const run = (change: (lhr: Lhr) => void = () => {}, formFactor: FormFactor = 'mobile', path = '/'): Run => {
  const lhr = goodLhr(formFactor);
  change(lhr);
  return { path, formFactor, lhr };
};

describe('runProblems', () => {
  it('finds nothing wrong with a result within every limit, as a phone or a desktop', () => {
    expect(runProblems(run())).toEqual([]);
    expect(runProblems(run(undefined, 'desktop'))).toEqual([]);
  });

  it('reports only the runtime error of a page Lighthouse could not measure', () => {
    const unmeasured = run((lhr) => {
      lhr.runtimeError = {
        code: 'ERRORED_DOCUMENT_REQUEST',
        message: 'Lighthouse was unable to reliably load the page you requested. (Status code: 404)',
      };
      // The rest of such a result describes no page.
      lhr.categories = {};
      lhr.audits = {};
    });
    expect(runProblems(unmeasured)).toEqual([
      'Lighthouse could not measure the page (ERRORED_DOCUMENT_REQUEST): Lighthouse was unable to reliably load the ' +
        'page you requested. (Status code: 404)',
    ]);
  });

  it('reports only the error of a run Lighthouse failed, which has no result', () => {
    expect(runProblems({ path: '/', formFactor: 'mobile', error: 'connect ECONNREFUSED 127.0.0.1:9222' })).toEqual([
      'connect ECONNREFUSED 127.0.0.1:9222',
    ]);
  });

  it('reports a run that emulated another form factor, or throttled other than by simulation', () => {
    expect(runProblems({ ...run(), formFactor: 'desktop' })).toEqual(['Lighthouse emulated mobile, not desktop']);
    for (const method of ['devtools', 'provided']) {
      const throttled = run((lhr) => {
        lhr.configSettings.throttlingMethod = method;
      });
      expect(runProblems(throttled), method).toEqual([`Lighthouse's throttling method was ${method}, not simulate`]);
    }
  });

  it('reports each category the result lacks, as it would one a later Lighthouse renamed', () => {
    for (const id of ['performance', 'accessibility', 'best-practices', 'seo']) {
      const lacking = run((lhr) => {
        delete lhr.categories[id];
      });
      expect(runProblems(lacking), id).toEqual([`Lighthouse reported no ${id} category`]);
    }
  });

  it('reports a performance score below 90, or none, and passes one of 90', () => {
    const scored = (score: number | null) =>
      run((lhr) => {
        lhr.categories.performance!.score = score;
      });
    expect(runProblems(scored(0.9))).toEqual([]);
    expect(runProblems(scored(0.89))).toEqual(['performance scored 89, below 90']);
    expect(runProblems(scored(null))).toEqual(['performance has no score']);
    // Its audits are scored by degree, so one short of full marks fails nothing by itself.
    const slowSpeedIndex = run((lhr) => {
      lhr.audits['speed-index']!.score = 0.5;
    });
    expect(runProblems(slowSpeedIndex)).toEqual([]);
  });

  it('names each audit that cost accessibility, best practices, or SEO full marks, even one rounding hides', () => {
    // An audit that failed, as the score shows.
    const lowContrast = run((lhr) => {
      lhr.categories.accessibility!.score = 0.94;
      lhr.audits['color-contrast']!.score = 0;
    });
    expect(runProblems(lowContrast)).toEqual(['accessibility scored 94, below 100: color-contrast did not pass']);
    // One that failed while the score stayed 1, as Lighthouse's rounding leaves it when the audits that count weigh at
    // least 200 times the failed one.
    const consoleErrors = run((lhr) => {
      lhr.audits['errors-in-console']!.score = 0;
    });
    expect(runProblems(consoleErrors)).toEqual(['best-practices scored 100: errors-in-console did not pass']);
    // One missing from the result, and one that could not run, which leaves the category no score.
    const unscored = run((lhr) => {
      lhr.categories.seo!.score = null;
      delete lhr.audits['is-crawlable'];
      lhr.audits['document-title'] = {
        score: null,
        scoreDisplayMode: 'error',
        errorMessage: 'Required DOM gatherer did not run.',
      };
    });
    expect(runProblems(unscored)).toEqual(['seo has no score: is-crawlable, document-title did not pass']);
    // Lighthouse scores a category with no audit that counts toward it 0, which fails though no audit did.
    const nothingApplies = run((lhr) => {
      lhr.categories.accessibility = { score: 0, auditRefs: [{ id: 'svg-img-alt', weight: 0 }] };
    });
    expect(runProblems(nothingApplies)).toEqual(['accessibility scored 0, below 100']);
  });

  it('reports a metric over its limit, compared in the units and decimals the table shows', () => {
    const measured = (id: string, value: number) =>
      runProblems(
        run((lhr) => {
          lhr.audits[id]!.numericValue = value;
        }),
      );
    expect(measured('largest-contentful-paint', 2500.4)).toEqual([]);
    expect(measured('largest-contentful-paint', 2500.6)).toEqual(['LCP 2501 ms, over 2500 ms']);
    expect(measured('cumulative-layout-shift', 0.1004)).toEqual([]);
    expect(measured('cumulative-layout-shift', 0.1006)).toEqual(['CLS 0.101, over 0.1']);
    expect(measured('total-blocking-time', 200)).toEqual([]);
    expect(measured('total-blocking-time', 350)).toEqual(['TBT 350 ms, over 200 ms']);
    // First contentful paint is reported, with no limit.
    expect(measured('first-contentful-paint', 60_000)).toEqual([]);
  });

  it('reports a metric the result lacks, as it would one a later Lighthouse renamed, or could not measure', () => {
    // FCP must be there too, though it has no limit.
    for (const id of [
      'largest-contentful-paint',
      'cumulative-layout-shift',
      'total-blocking-time',
      'first-contentful-paint',
    ]) {
      const lacking = run((lhr) => {
        delete lhr.audits[id];
      });
      expect(runProblems(lacking), id).toEqual([`Lighthouse reported no ${id} audit`]);
    }
    const noLcp = run((lhr) => {
      lhr.audits['largest-contentful-paint'] = {
        score: null,
        scoreDisplayMode: 'error',
        errorMessage: 'The page did not display content that qualifies as a Largest Contentful Paint (LCP). (NO_LCP)',
      };
    });
    expect(runProblems(noLcp)).toEqual([
      'Lighthouse measured no LCP (error): The page did not display content that qualifies as a Largest Contentful ' +
        'Paint (LCP). (NO_LCP)',
    ]);
    const notApplicable = run((lhr) => {
      lhr.audits['total-blocking-time'] = { score: null, scoreDisplayMode: 'notApplicable' };
    });
    expect(runProblems(notApplicable)).toEqual(['Lighthouse measured no TBT (notApplicable)']);
  });

  it('reports every problem a result has, settings first, then categories, then metrics', () => {
    const everything = run((lhr) => {
      lhr.configSettings = { formFactor: 'desktop', throttlingMethod: 'devtools' };
      lhr.categories.performance!.score = 0.5;
      lhr.audits['image-alt']!.score = 0;
      lhr.categories.accessibility!.score = 0.59;
      lhr.audits['cumulative-layout-shift']!.numericValue = 0.25;
      lhr.audits['total-blocking-time']!.numericValue = 610;
    });
    expect(runProblems(everything)).toEqual([
      'Lighthouse emulated desktop, not mobile',
      "Lighthouse's throttling method was devtools, not simulate",
      'performance scored 50, below 90',
      'accessibility scored 59, below 100: image-alt did not pass',
      'CLS 0.25, over 0.1',
      'TBT 610 ms, over 200 ms',
    ]);
  });
});

describe('lighthouseCheck', () => {
  it('passes each run within every limit, and names each problem with the others by page and form factor, in order', () => {
    const failed: Run = { path: '/', formFactor: 'desktop', error: 'Lighthouse returned no result' };
    const slow = run(
      (lhr) => {
        lhr.categories.performance!.score = 0.8;
        lhr.audits['largest-contentful-paint']!.numericValue = 3100;
      },
      'mobile',
      '/resume/',
    );
    expect(lighthouseCheck([run(), failed, slow, run(undefined, 'desktop', '/resume/')])).toEqual({
      passed: ['/ (mobile)', '/resume/ (desktop)'],
      failures: [
        '/ (desktop): Lighthouse returned no result',
        '/resume/ (mobile): performance scored 80, below 90',
        '/resume/ (mobile): LCP 3100 ms, over 2500 ms',
      ],
    });
  });
});

describe('report', () => {
  it("tables each run's scores and metrics under the limits, after a note that they are lab results", () => {
    const resume = run(
      (lhr) => {
        lhr.categories.performance!.score = 1;
        lhr.audits['largest-contentful-paint']!.numericValue = 320.6722;
        lhr.audits['first-contentful-paint']!.numericValue = 320.6722;
        lhr.audits['cumulative-layout-shift']!.numericValue = 0.01234;
        lhr.audits['total-blocking-time']!.numericValue = 12.5;
      },
      'desktop',
      '/resume/',
    );
    expect(report([run(), resume])).toEqual([
      'Lab results, not field data: one Lighthouse load of each page per form factor, with simulated throttling, ' +
        "from a local server that compresses files as CloudFront does. Visitors' devices and networks vary, and " +
        "Lighthouse doesn't measure INP, which needs a visitor's interactions; TBT stands in for it.",
      '',
      '| Page | Form factor | Performance | Accessibility | Best practices | SEO | LCP | CLS | TBT | FCP |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
      '| Limit |  | ≥ 90 | 100 | 100 | 100 | ≤ 2500 ms | ≤ 0.1 | ≤ 200 ms |  |',
      '| / | mobile | 99 | 100 | 100 | 100 | 1598 ms | 0 | 0 ms | 1598 ms |',
      '| /resume/ | desktop | 100 | 100 | 100 | 100 | 321 ms | 0.012 | 13 ms | 321 ms |',
    ]);
  });

  it('shows a dash for each score or metric the result lacks, and for every value of a run that failed', () => {
    const lacking = run((lhr) => {
      lhr.categories.performance!.score = null;
      delete lhr.categories.seo;
      lhr.audits['largest-contentful-paint'] = { score: null, scoreDisplayMode: 'error' };
      delete lhr.audits['total-blocking-time'];
    });
    const failed: Run = { path: '/resume/', formFactor: 'desktop', error: 'Lighthouse returned no result' };
    expect(report([lacking, failed]).slice(-2)).toEqual([
      '| / | mobile | — | 100 | 100 | — | — | 0 | — | 1598 ms |',
      '| /resume/ | desktop | — | — | — | — | — | — | — | — |',
    ]);
  });
});
