# Phase 2 design inputs

From the Phase 1 review of 2026-10-15: six reviewers covered the whole of Phase 1, and two skeptics checked each finding. What Phase 1 had to fix went into ADRs 0004 to 0009. What's left here needs no change before Phase 2; each item says when it applies.

## Releases

- **Speed.** The release scripts make one AWS CLI call per object, one after another, at about a second each (ADR 0006, "Limits"). Before the site passes about 200 files, run each phase's calls a few at a time (4 to 8), keeping the page order's ranks and the history's ordering rules, or add a file ceiling to `check:dist` beside `SMOKE_REQUEST_BUDGET`.
- **Storage.** Every release stores a full copy, unchanged assets included, and nothing prunes copies. Prefer storing each file once, by its SHA-256, to copying assets into every release. Choose a retention rule that an administrator applies from `history.json`, keeping the current release and every release a rollback or Restore could still use, rather than an age-based lifecycle rule. Narrow the bucket listing to the keys `stalePages` needs, so it stays far below its 16 MiB buffer.

## Requests and bandwidth

- **Rate limit.** `RATE_LIMIT_PER_IP`, 1,000 requests per 5 minutes, was sized for the placeholder's 4 requests per first visit (ADR 0007). Measure the 3D pages' cold-load request count, re-derive the limit from how many first visits one shared address should get, and keep `SMOKE_REQUEST_BUDGET` at most half of it.
- **The browser check's requests** count against the same limit, with no budget: three page loads with an empty cache from one runner. Count them in `browserCheck`, so CI and the build job fail before publishing, and fail above a budget tied to the limit.
- **Compression.** CloudFront compresses only the content types on its list, and only files between 1 KB and 10 MB. `model/gltf-binary`, `model/gltf+json`, `image/ktx2`, and `application/octet-stream` aren't on it, and the release scripts set no `Content-Encoding`. Prefer formats compressed inside the file: Draco geometry, KTX2 with Basis or Zstandard supercompression, WebP or AVIF. If meshopt or plain glTF is chosen instead, teach the release scripts precompressed objects first.
- **Allowance.** Estimate monthly requests and bytes, visitors times each first visit's payload plus every release's checks, against the Free flat-rate plan's 1 million requests and 100 GB. If a higher tier looks likely, write its runbook first. CloudFormation won't change a subscription's tier, so the tier changes through the PricingPlanManager API, with the owner's approval. A reviewed change then makes the config, the template, and the guardrails' Free-tier rules match, and the payer budget rises above the tier's price.

## 3D content

- **Assets and decoders.** Import models, textures, and decoders through Vite, so they're hashed under `assets/`, never in `public/`. Self-host the Draco and Basis decoders instead of drei's CDN defaults. Add content types, `wasm` first, as each format is chosen.
- **Readiness.** The browser check would pass a scene that never renders, and it sees only SwiftShader's WebGL2, with no WebGPU. Have the app set a readiness state on the root element once the scene has drawn with its first assets. Have both browser runs wait for it, with timeouts sized for software rendering, and fail on a failed state or a timeout. Decide how the `h1` rule applies to a canvas landing, and how real devices get tested.
- **Testing.** Keep the 100% coverage gate: `@react-three/test-renderer`, in the node environment, reaches it under the current config. Keep scene logic in pure modules, inject GPU capabilities, and stub loaders. Record the decision in an ADR before the first scene pull request.
- **Styles.** `src/styles.test.ts` emulates layout in jsdom and will reject a full-viewport canvas. Before retiring it, extend the browser check: every Tab stop on every page, a middle width such as 768 px, and scrollbars shown.
- **Content module.** The prerender, `check:dist`, and the browser check load `src/content.ts` under plain Node. Keep it plain data, with no asset, `?url`, or `.tsx` imports, and put scene content in other modules.

## Routing and headers

- **Routes.** Every route is a prerendered file, and an unknown path gets the 404 page with status 404. Keep one route table for the app, prerendering, the sitemap's test, `check:dist`, and both browser runs. Put shareable 3D state in the URL fragment, which never reaches the server.
- **Path mapping.** `check:dist`, the smoke test, and the browser check's local server copy the viewer-request function's path mapping. Before changing routing, add a test that runs the real function against those copies, and stage the change as ADR 0006's "Infrastructure first" says.
- **Headers.** Only the Business tier and above allow custom response-headers policies. So a Content-Security-Policy comes from a viewer-response CloudFront Function, which doesn't run on the origin's 404 responses, or from a `<meta>` tag in both pages. Self-host every runtime dependency first.

## Operations and security

- **Detection and response.** Nothing detects misuse quickly: the budget's alerts follow billing data by 8 to 24 hours, and the SCP denies in-account detectors in us-east-1. The owner decides, through the `docs/org-policy` runbook, among an organization CloudTrail trail, GuardDuty, and a daily cost budget for the Website account that alerts an address outside zachdavids.com. Add a one-page incident runbook covering:
  - cutting off a stolen session with a deny SCP from the management account;
  - removing `SiteDeployPolicy`;
  - an IAM sweep in every Region;
  - a zone diff, MX, SPF, DKIM, and DMARC included.
- **Read-only access for agents.** A read-only Identity Center permission set, created with the owner's approval, would let agents read AWS outside the administrator's sessions (ADR 0004, "Administrative access").
- **CAA.** After milestone 9 ends the rollback window, add an apex CAA record set naming Amazon (`0 issue "amazon.com"`), through a new, reviewed batch kind whose test refuses a set that names no Amazon CA. Not before: the Droplet's certificate renewals and milestone 8's rollback need Let's Encrypt.
- **Dependencies.** npm gets security updates only (ADR 0005). Upgrade deliberately when each milestone starts:
  - run `npm outdated` in both packages;
  - move the CDK CLI with `aws-cdk-lib`, and Playwright with the Chromium the checks download;
  - keep React within React Three Fiber's peer range.

## Upkeep

- **At the next CDK or Node.js upgrade:** register the guardrail plugin directly and drop the test that decodes CDK's analytics string, accepting a one-time, metadata-only change to both stacks. Delete the unused DNS-write allowance and its tests.
- **Signed-in CDK runs:** running the app under Node's own type stripping instead of `tsx` would keep `tsx` and `esbuild` out of the administrator's session (ADR 0004).
- **Docs.** Keep ADRs to decisions, reasons, and consequences. Put runbooks in their own sections and verification logs in pull request descriptions, with a pointer from `docs/progress.md`. Name a test instead of restating what it checks.
- **Waiting runs.** GitHub's `queue: max` would let waiting deploys queue instead of replacing each other (ADR 0005, "Order"). Revisit it only if runs start to overlap often.
