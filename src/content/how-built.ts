import type { Section } from './prose.ts';

// How the site is built, from what the repository records: its decision records (docs/adr/), its workflows and
// checks, and its pull requests. Keep it true as the site changes, and recheck its dated claims with each revision:
// the intro's "as of" date, the rollback's record, and the plans under "Trade-offs and limits". Zach approved this text
// on 2026-10-22.

/** A link to the repository on GitHub. */
export interface SourceLink {
  label: string;
  href: string;
}

export interface HowBuilt {
  title: string;
  description: string;
  intro: readonly string[];
  sections: readonly Section[];
  /** The repository and the decision records the page names, on GitHub. */
  links: readonly SourceLink[];
}

export const howBuilt = {
  title: 'How this site is built',
  description: 'How zachdavids.com is built: static hosting, live release checks with rollback, a DNS move that left every email record unchanged, and how I direct an AI coding agent.',
  intro: [
    "I set this site's requirements and made or approved its architectural decisions; Claude Code, Anthropic's AI coding agent, wrote the site's code, tests, documentation, and pull-request descriptions. Five decisions shaped it; this page describes them as of October 2026.",
    'On 2026-10-18, two tested DNS changes moved the site from a DigitalOcean server to CloudFront with every email record unchanged.',
  ],
  sections: [
    {
      id: 'architecture',
      heading: 'Decision 1: a static site on S3 and CloudFront',
      paragraphs: [
        "The pages are static: prerendering turns each into plain HTML that works without JavaScript, and CloudFront, through origin access control, serves it from an S3 bucket visitors can't reach directly, leaving no server to patch. Two AWS CDK stacks define the site and its deploy role, and tests check each stack change before an administrator deploys it.",
        "Cost set the limits: CloudFront's Free flat-rate plan covers the distribution, the AWS WAF firewall it requires, and the DNS zone at no cost or overage, but allows five firewall rules and 50 zone records, and may slow sustained traffic past its monthly allowance rather than bill it.",
      ],
    },
    {
      id: 'email',
      heading: 'Decision 2: protect email through the DNS move',
      paragraphs: [
        "The domain's DNS zone also holds my Google Workspace email's MX, SPF, DKIM, and DMARC records, so a bad DNS change could stop mail. I treated DNS as the move's riskiest part and kept it out of the CDK stacks, which would own each record and write it with administrator permissions; template checks in every synthesis refuse DNS records and DNS write access.",
        'Each routing change was a committed Route 53 change batch with an exact reverse, applied with my approval, and would have failed whole if a record it named had changed since review. Tests replayed the batches on a model of the zone: only the website records changed.',
        "Each change's zone diff showed exactly what was planned. Afterwards, a message from an outside account reached my mailbox, and my reply passed SPF, DKIM, and DMARC against the domain's own records.",
      ],
      list: [
        'Rejected: UPSERT, which overwrites whatever is there, so no reverse could know what it replaced; and rolling back from a whole-zone export, which would undo later email changes.',
        'Cost: Route 53 has no dry run, and the tests only model it, so a reverse first meets the real service when used.',
        "Accepted: I retired the old server once the move's checks passed that day, not after the 7 to 14 clean days the project plan called for, ending the DNS fallback early, so CloudFront problems are fixed on CloudFront's side.",
      ],
    },
    {
      id: 'releases',
      heading: 'Decision 3: check each release where viewers get it',
      paragraphs: [
        "CI tests the build, not what CloudFront serves: headers, redirects, and how the deployed CloudFront Function maps URLs to pages can only be checked live. CI's run on a merge commit also starts alongside the deploy instead of gating it.",
        "The Deploy workflow publishes exactly the files its build checked, verified by its SHA-256 digest, then smoke-tests every file through CloudFront and loads every page there in Chromium, to catch a script that throws or a layout that breaks. Each page names its release's commit, so the checks know what they're testing; if either fails, the run puts back the newest release that passed its checks and fails visibly.",
      ],
      list: [
        'Rejected: deleting old assets, which cached or restored pages may still load.',
        'Cost: a failure that only the live checks catch has already gone public when the rollback starts.',
        'Tested, not yet needed: unit tests cover the rollback, and a rehearsed restore ran the same republish and smoke test live. No release has failed its live checks, so the rollback has never republished anything live.',
      ],
    },
    {
      id: 'access',
      heading: 'Decision 4: give the pipeline only what a release needs',
      paragraphs: [
        "The Deploy workflow can publish the site and little else. It holds no stored AWS key: GitHub's OIDC token gets it short-lived credentials for a role that trusts only this repository's production environment on main. That role can't change IAM, DNS, or infrastructure, and can't delete an asset, release record, or object version, so anything it overwrites or deletes stays recoverable for 90 days.",
        'Rules for the stacks and workflows are checked in code, not memory: template checks in every CDK synthesis limit what a stack may contain and what the deploy role may be granted, and repository policy tests check the workflows.',
        "Evidence: in IAM's policy simulator, the role was denied changing DNS, assuming the CDK roles, passing roles, changing its own policy, and those deletions. A stack broken on purpose failed the template checks.",
      ],
      list: [
        'Cost: every resource is retained, so one removed from the code stays in AWS until an administrator deletes it.',
        'Limit: the checks constrain the code, not someone with administrator access.',
      ],
    },
    {
      id: 'ai',
      heading: 'Decision 5: direct the AI, and check its work',
      paragraphs: [
        "For Phase 2's portfolio pages, I set the bar: every page prerendered and working without JavaScript, axe-core and Lighthouse in CI, size budgets, and URL handling verified as production serves it (ADR 0010). While Claude's release pipeline was in review, I asked for five changes, among them a browser check and an automatic rollback. One was restores that last: as built, the next push to main would have republished main and quietly undone a restore, so a restore now holds deploys until a deploy started by hand resumes them. I declined two homepage concepts Claude generated, approve every fact the site publishes, and merge each milestone once the required CI jobs pass.",
        "The agent works within written decision records and automated checks of their rules. But it wrote the checks too, so a pass shows that code and checks agree, not that a change is safe; I give more weight to checks shown to catch a planted fault. No workflow calls an AI.",
        "Separate Claude agents review each milestone's pull request, and others try to refute each finding before any fix. That's AI checking AI, and GitHub records no review by a person. It still finds real defects: one review caught three DNS batches, the move's reverse among them, that Route 53 would have refused for comments over its 256-character limit, which the tests now check. After six review agents covered Phase 1, I chose three of their proposed fixes: short AWS admin sessions, an external uptime monitor, and approval for outside contributors' workflows.",
      ],
    },
    {
      id: 'limits',
      heading: 'Trade-offs and limits',
      paragraphs: [],
      list: [
        "Simplicity over flexibility: apart from the CloudFront Function, there's no server code, so anything dynamic needs a new decision.",
        'Testing: the browser checks use only Chromium, with JavaScript on, and automated accessibility checks stand in for a planned screen-reader review on real devices.',
        'Measurement: performance figures come from a lab, with no field data, so INP goes unmeasured.',
        'Recovery: the automatic rollback covers neither a deploy cancelled partway nor a bug in the release scripts it shares with publishing and restores.',
        "Planned: 3D in Phase 3, with the firewall's rate limit re-derived for it.",
      ],
    },
    {
      id: 'deep-dive-checks',
      heading: 'Deep dive: the checks',
      deepDive: true,
      paragraphs: [
        'Two required jobs, Web and Infra, run on every pull request into main, with no AWS access. One page table feeds the app, the prerender, and the build, browser, and Lighthouse checks, so each check finds every page by itself.',
        "Checks miss what they don't model: only the deployed CloudFront Function showed that its www redirect can reorder query parameters, which is harmless because the site ignores query strings.",
        'In Phase 1, the policy tests and the browser check were shown to catch planted faults: each of 65 deliberate breaks to the workflows failed the policy tests, and every build broken on purpose failed the browser check, while two harmless edits and the unbroken build passed.',
      ],
      list: [
        'Typecheck and tests: strict TypeScript, and unit tests at 100% coverage in both packages.',
        "The build check: each page's prerendered HTML holds its key text, head tags, structured data, and links; every file it references exists under the exact name S3 looks up; and the build fits budgets counted roughly as CloudFront sends each file, gzipped where it compresses: 100 KiB of JavaScript, 10 KiB of CSS, 30 KiB for the largest page, 100 KiB of images, and no fonts.",
        "The browser check, in Chromium: each page at 320, 768, and 1280 pixels and in dark mode at 320, and the 404 page at 320 in light and dark mode; no script error, console error, or failed request; no sideways scrolling; at 320 pixels, in light and dark mode, a focus outline or shadow at every Tab stop; no violation of axe-core's WCAG A and AA rules; and each page at its other URLs, with a made-up path below each getting the 404 page.",
        'Lighthouse, as a phone and as a desktop, in CI only, since lab scores vary from run to run: Performance at least 90; Accessibility, Best Practices, and SEO at 100; LCP at most 2.5 s, CLS at most 0.1, and total blocking time at most 200 ms, standing in for INP.',
        "Template checks, in every synthesis: no DNS records, and no permission that can write DNS, failing closed on any grant they can't read; no Lambda functions, custom resources, StackSets, or nested stacks, and no Lambda@Edge, which the plan bills outside the flat rate; every resource retained; the Free plan's limits on the distribution and its firewall; GitHub trust only for this repository's production environment on main; and an allowlist of what the deploy role may be granted (ADR 0003). The CDK CLI tells an app not to fail on validation errors, so this app overrides that: any violation fails every command that synthesizes it, whatever its flags (ADR 0003).",
        'Repository policy tests: actions pinned to full commit SHAs; AWS credentials only through OIDC, never from stored secrets; no expressions inside run scripts; dependency install scripts turned off; a sha512 hash for every locked package; and a credential scan.',
      ],
    },
    {
      id: 'deep-dive-release',
      heading: 'Deep dive: how a release goes out',
      deepDive: true,
      paragraphs: [
        "Vite's own SSR build prerenders each page from the typed content in src/content/ to its own HTML file, which React hydrates; links are plain links, with no client-side router. The components hold only interface words, so a redesign can replace the layout without touching the facts (ADR 0010). React stays within React Three Fiber's peer range, for Phase 3's 3D (ADR 0001).",
        "The jobs that hold the AWS role install no packages, and the jobs that download Chromium get no AWS role. Content-hashed assets are cached for a year and never deleted, so a page cached from an older release still finds its files. Known costs: each release stores a full copy that nothing prunes yet; the scripts make about two AWS CLI calls per file, one after another, so with a slow invalidation the jobs' time limits allow about 200 files; and each live check runs from one GitHub runner, so it sees one CloudFront edge location.",
        'Restore, a second workflow, republishes a verified release from its saved copy, and the automatic rollback never goes back past a restore.',
        "A push to main runs the Deploy workflow's four jobs in order:",
      ],
      list: [
        'Build, without AWS access: typecheck, tests, build, and the build check; then a SHA-256 digest of every file, an upload of the files as a workflow artifact, and the browser check, so Chromium runs only once the files are fixed.',
        "Deploy, with the role: check the files against the digest before getting credentials; refuse a commit older than the newest one published, since runs can arrive out of push order, and any release while a restore holds deploys; upload new assets, save a copy of the release, publish the pages with the home page last, and wait for CloudFront's invalidation; then smoke-test through CloudFront, including that the bucket refuses direct requests.",
        'Browser, without AWS access: the browser check again, on the live release.',
        'Verify, with the role: record the release as verified if both checks passed; otherwise put back the newest release that passed its checks or was restored, smoke-test it, and fail the run.',
      ],
      ordered: true,
    },
    {
      id: 'deep-dive-dns',
      heading: 'Deep dive: the DNS move',
      deepDive: true,
      paragraphs: [
        "The move waited for a verified release, a rehearsed restore, checks passing through the firewall under the site's own names, and a finished registrar transfer. It took two batches: one lowered the three website records' TTL from 30 minutes to 5, and at least 40 minutes later, one atomic batch swapped the apex A and AAAA records and the www CNAME for four aliases to CloudFront.",
        "After the swap, the site, the HTTPS and www redirects, the 404 page, and the certificate were checked through public DNS over IPv4 and IPv6, and a Deploy run started by hand passed. That evening, I saw the external monitor's checks passing.",
        "Replacing www's CNAME stopped mail lookups at www from following it to the apex's MX and SPF records. Mail sent to an address at www, which Google refused before, now fails after the sender's retries instead. I had confirmed beforehand that www isn't a mail domain.",
        "Retiring the server also meant deleting the move's batches, reverses included, because DigitalOcean may give the server's old IP addresses to someone else; a test now refuses any committed batch that gives a website A or AAAA record those addresses.",
      ],
    },
  ],
  links: [
    { label: 'Source on GitHub', href: 'https://github.com/zachdavids/zachverse' },
    { label: 'All decision records', href: 'https://github.com/zachdavids/zachverse/tree/main/docs/adr' },
    {
      label: 'ADR 0001: Web toolchain and prerendering',
      href: 'https://github.com/zachdavids/zachverse/blob/main/docs/adr/0001-web-toolchain-and-prerendering.md',
    },
    {
      label: 'ADR 0002: Region, certificate, and organization-policy constraints',
      href: 'https://github.com/zachdavids/zachverse/blob/main/docs/adr/0002-region-certificate-and-managed-policy-constraints.md',
    },
    {
      label: 'ADR 0003: Site distribution design',
      href: 'https://github.com/zachdavids/zachverse/blob/main/docs/adr/0003-site-distribution-design.md',
    },
    {
      label: 'ADR 0004: GitHub deploy identity',
      href: 'https://github.com/zachdavids/zachverse/blob/main/docs/adr/0004-github-deploy-identity.md',
    },
    {
      label: 'ADR 0005: Deploy workflow',
      href: 'https://github.com/zachdavids/zachverse/blob/main/docs/adr/0005-deploy-workflow.md',
    },
    {
      label: 'ADR 0006: Releases, smoke tests, and rollback',
      href: 'https://github.com/zachdavids/zachverse/blob/main/docs/adr/0006-releases-smoke-tests-and-rollback.md',
    },
    {
      label: 'ADR 0007: Web ACL and the Free flat-rate plan',
      href: 'https://github.com/zachdavids/zachverse/blob/main/docs/adr/0007-web-acl-and-free-flat-rate-plan.md',
    },
    {
      label: 'ADR 0008: Website DNS cutover',
      href: 'https://github.com/zachdavids/zachverse/blob/main/docs/adr/0008-website-dns-cutover.md',
    },
    {
      label: 'The rules for DNS change batches, and why DNS stays outside CDK',
      href: 'https://github.com/zachdavids/zachverse/blob/main/infra/dns/README.md',
    },
    {
      label: 'ADR 0009: DigitalOcean retirement',
      href: 'https://github.com/zachdavids/zachverse/blob/main/docs/adr/0009-digitalocean-retirement.md',
    },
    {
      label: "ADR 0010: The Phase 2 site's design, content, pages, and checks",
      href: 'https://github.com/zachdavids/zachverse/blob/main/docs/adr/0010-phase-2-site.md',
    },
    {
      label: 'The repository policy tests',
      href: 'https://github.com/zachdavids/zachverse/blob/main/tests/repo-policy.test.ts',
    },
  ],
} as const satisfies HowBuilt;
