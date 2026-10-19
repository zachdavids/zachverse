# Phase 2 design inputs

From the Phase 1 review of 2026-10-15: six reviewers covered the whole of Phase 1, and two skeptics checked each finding. What Phase 1 had to fix went into ADRs 0003 to 0007, into ADRs 0008 and 0009 on #8 and #11, and, for what the owner does, `docs/progress.md`. What's left here needs no change before Phase 2; an item that names no time applies from the start of Phase 2's design.

**Status after Phase 2's milestone 1 (2026-10-18).** Phase 2, as the owner planned it on 2026-10-16, has no 3D (ADR 0010; `docs/progress.md`, "Phase 2"). So the "3D content" section, apart from "Content module", "Styles", and "Prerendering", which apply to every page, and the 3D parts of "Rate limit" and "Compression", now apply to Phase 3.

Milestone 1 addressed these items:
- **Routes:** one page table, `pages` in `src/content/site.ts`.
- **Path mapping:** `tests/path-mapping.test.ts` runs the real function against both copies.
- **Browser check:** a request budget tied to the rate limit.
- **Content module:** now `src/content/`, still plain data.
- **Styles:** in part. The browser check now walks every Tab stop on every page at 320 pixels, loads each page at a middle width, 768 pixels, and shows scrollbars. `src/styles.test.ts` stays, since no canvas has come.
- **Allowance:** estimated for milestone 1's pages (ADR 0010, "Load and allowance"); Phase 3 estimates it again for its 3D assets.
- **Docs:** milestone 1's verification log is in its pull request's description, and ADR 0010 names its tests rather than restating them.
- **Dependencies:** for milestone 1, by the owner's choice on 2026-10-19 (`docs/progress.md`, "Phase 2").

The rest are open.

## Releases

- **Speed.** The release scripts handle one object per AWS CLI call, one call after another, at about a second each (ADR 0006, "Limits"). Before the site passes about 200 files, run each publishing step's per-file calls a few at a time (4 to 8), keeping the page order's ranks and the history's ordering rules, or add a file ceiling to `check:dist` beside `SMOKE_REQUEST_BUDGET`.
- **Storage.** Every release stores a full copy, unchanged assets included, and nothing prunes copies. Prefer storing each file once, by its SHA-256, to copying assets into every release. Choose a retention rule that keeps the current release and every release a rollback could still use, rather than an age-based lifecycle rule. Restore offers every verified release, so the history has to record what is pruned, and pruning needs a reviewed workflow in the deploy and Restore workflows' concurrency group, since nothing else may write the site's objects (ADR 0006, "One publication at a time"). Narrow the bucket listing to the keys `stalePages` needs, so it stays far below its 16 MiB buffer.

## Requests and bandwidth

- **Rate limit.** `RATE_LIMIT_PER_IP`, 1,000 requests per 5 minutes, was sized for the placeholder's four requests per first visit (ADR 0007). Measure the 3D pages' cold-load request count, re-derive the limit from how many first visits one shared address should get, and keep `SMOKE_REQUEST_BUDGET` at most half of it.
- **Browser check.** Its requests count against the same limit, with no budget: three page loads with an empty cache from one runner. Count them in `browserCheck` and fail above a budget tied to the limit, so CI and the build job fail before anything is published.
- **Compression.** CloudFront compresses only the content types on its list, and only files between 1 KB and 10 MB. `model/gltf-binary`, `model/gltf+json`, `image/ktx2`, and `application/octet-stream` aren't on it, and the release scripts set no `Content-Encoding`. Prefer formats compressed inside the file: Draco geometry, KTX2 with Basis or Zstandard supercompression, WebP or AVIF. If meshopt or plain glTF is chosen instead, teach the release scripts precompressed objects first.
- **Allowance.** Estimate monthly requests and bytes, visitors times each first visit's payload plus every release's checks, against the Free flat-rate plan's 1 million requests and 100 GB. If a higher tier looks likely, write its runbook first. CloudFormation won't change a subscription's tier, so the tier changes through the PricingPlanManager API, with the owner's approval. A reviewed change then makes the config and the template match the new tier, and the payer budget rises above the tier's price. The guardrails keep the Free tier's limits, which every paid tier accepts; if Phase 2 adopts a paid-only feature, make them tier-aware first.

## 3D content

- **Assets and decoders.** Import models, textures, and decoders through Vite, so they're hashed under `assets/`, never in `public/`. Self-host the Draco and Basis decoders instead of drei's CDN defaults. Add content types, `wasm` first, as each format is chosen.
- **Readiness.** The browser check would pass a scene that never renders, and it sees only SwiftShader's WebGL2, with no WebGPU. Have the app set a readiness state on the root element once the scene has drawn with its first assets. Have both browser runs wait for it, with timeouts sized for software rendering, and fail on a failed state or a timeout. Decide how the `h1` rule applies to a canvas landing, and how real devices get tested.
- **Testing.** Keep the 100% coverage gate: `@react-three/test-renderer`, in the node environment, reaches it under the current config. Keep scene logic in pure modules, inject GPU capabilities, and stub loaders. React Three Fiber's `<Canvas>` throws under jsdom, which has no `ResizeObserver`, and `src/main.test.tsx` renders and hydrates the pages there: stub `ResizeObserver` in each jsdom test that reaches a canvas, since `tests/repo-policy.test.ts` allows no `setupFiles`. Record the decision in an ADR before the first scene pull request.
- **Styles.** `src/styles.test.ts` pins the stylesheet's rules in jsdom, which does no layout, and will reject a full-viewport canvas. Before retiring it, extend the browser check: every Tab stop on every page, a middle width such as 768 px, and scrollbars shown.
- **Content module.** The prerender, `check:dist`, and the browser check load `src/content/` (until Phase 2, `src/content.ts`) under plain Node. Keep it plain data, with no asset, `?url`, or `.tsx` imports, and put scene content in other modules.
- **Prerendering.** The prerender imports the server bundle under plain Node, so a module that reads `window`, `document`, or `self` when it's imported fails the build. `renderToString` also sends a `React.lazy` component's nearest `Suspense` fallback instead of waiting for it, and hydrating that boundary reports React error #419, which fails the browser check. So render the page's `h1` and links as content, never as a fallback the scene replaces, and mount the scene only after hydration, from a lazily loaded module that holds the three, React Three Fiber, and drei imports.

## Routing and headers

- **Routes.** Every route is a prerendered file, and an unknown path gets the 404 page with status 404, though `npm run dev` and `npm run preview` answer it with `index.html`. A path whose last segment has a dot is looked up as a file, so a dotted route needs a trailing slash. Keep one route table for the app, prerendering, the sitemap's test, `check:dist`, and both browser runs. Put shareable 3D state in the URL fragment, which never reaches the server.
- **Path mapping.** `check:dist`, the smoke test, and the browser check's local server copy the viewer-request function's path mapping. Before changing routing, add a test that runs the real function against those copies, and stage the change as ADR 0006's "Infrastructure first" says. Deploy the infrastructure from the change's branch just before merging it, merging nothing else and running no Deploy or Restore in between, since those would check the new routing with `main`'s old copies; or first ship checks that accept both behaviors.
- **Headers.** Only the Business tier and above allow custom response-headers policies. So a Content-Security-Policy comes from a viewer-response CloudFront Function, which doesn't run on the origin's 404 responses, or from a `<meta>` tag in both pages. Self-host every runtime dependency first.

## Operations and security

- **Detection and response.** Nothing detects misuse quickly: in us-east-1 the SCP denies GuardDuty, CloudTrail trails, CloudWatch alarms, EventBridge, and SNS, though not AWS Config or IAM Access Analyzer, and the budget's alerts can come a day or more after the spending, since AWS updates billing data at least once a day and budgets 8 to 12 hours apart. The owner decides, through the `docs/org-policy` runbook, among an organization CloudTrail trail, GuardDuty, and a daily cost budget for the Website account that alerts an address outside zachdavids.com. Add a one-page incident runbook covering:
  - cutting off a stolen session with a deny SCP from the management account;
  - removing `SiteDeployPolicyEEC9A210` (ADR 0006, "When a release fails");
  - an IAM sweep, and a sweep of every Region's resources and charges;
  - a zone diff, MX, SPF, DKIM, and DMARC included.
- **Read-only access for agents.** A read-only Identity Center permission set, created with the owner's approval, would let agents read AWS outside the administrator's sessions (ADR 0004, "Administrative access"). Its CLI sessions would come from `aws sso login`, which `aws logout --all` doesn't end (`aws sso logout` does) and `ls ~/.aws/login/cache` doesn't show, so ADR 0004's session rule and its no-session check need extending to them first.
- **CAA.** After milestone 9 ends the rollback window, add an apex CAA record set naming Amazon (`0 issue "amazon.com"`), through a new, reviewed batch kind whose test refuses a set that names no Amazon CA. Not before: the Droplet's certificate renewals and milestone 8's rollback need Let's Encrypt. The set also covers every subdomain without a set of its own, so a later name whose certificate comes from another CA needs that CA added first. ACM checks the set only when it issues or renews a certificate, so a mistake can show months later: pair the batch with a reverse batch that deletes the set.
- **Dependencies.** npm gets security updates only (ADR 0005). Upgrade deliberately when each milestone starts:
  - run `npm outdated` in both packages;
  - move the CDK CLI with `aws-cdk-lib`, and Playwright with the Chromium the checks download;
  - keep React within React Three Fiber's peer range.

## Upkeep

- **Next CDK or Node.js upgrade.** Register the guardrail plugin directly and drop the test that decodes CDK's analytics string, accepting a one-time, metadata-only change to both stacks. Delete the unused DNS-write allowance for ACM validation CNAMEs (ADR 0003, "Template checks") and its tests.
- **Signed-in CDK runs.** Running the app under Node's own type stripping instead of `tsx` would keep `tsx` and `esbuild` out of the administrator's session (ADR 0004). Node won't load the app as written, so `infra/` first needs the module setup `scripts/` already has: `"type": "module"` in its `package.json`, `.ts` extensions on relative imports, and `allowImportingTsExtensions` for the typecheck, as `tsconfig.release.json` sets it. `infra/lib/viewer-request.ts` also needs `import.meta.dirname` in place of `__dirname`.
- **Docs.** Keep ADRs to decisions, reasons, and consequences. Put runbooks in their own sections and verification logs in pull request descriptions, with a pointer from `docs/progress.md`. Name a test instead of restating what it checks.
- **Waiting runs.** GitHub's `queue: max` would let waiting deploys queue instead of replacing each other (ADR 0005, "Order"). Revisit it only if runs start to overlap often.
