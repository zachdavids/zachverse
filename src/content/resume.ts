// Zach's résumé, as the résumé page shows it: the public version of his latest résumé ("ZachDavidsResume",
// 2026-10-14), which he approved for the site on 2026-10-18 and 2026-10-19. It keeps the résumé's wording, without its
// bold and italic emphasis, but leaves out the phone number and every location (his city and each employer's and
// school's), and the figures he keeps private: business, traffic, and engagement numbers, and exact fleet scale, which
// it gives in round words instead ("millions of devices"). The full résumé is shared on request, not published.

export interface Project {
  /** Stable: never reused for another project. */
  id: string;
  name: string;
  highlights: readonly string[];
}

export interface Role {
  /** Stable: never reused for another role. */
  id: string;
  employer: string;
  title: string;
  dates: string;
  highlights: readonly string[];
  projects: readonly Project[];
}

export interface Skill {
  /** Stable: never reused for another skill group. */
  id: string;
  name: string;
  items: string;
}

export interface Education {
  /** Stable: never reused for another degree. */
  id: string;
  school: string;
  degree: string;
  date: string;
}

export interface Resume {
  headline: string;
  summary: readonly string[];
  skills: readonly Skill[];
  experience: readonly Role[];
  education: readonly Education[];
}

export const resume = {
  headline: 'Senior Software Engineer | Embedded Linux, C++ & Device Platforms',
  summary: [
    'Senior Software Engineer with 6.5+ years of professional experience building embedded C++ systems, device-platform software, and AWS services across Kindle and Amazon Kids at Amazon.',
    'Specializes in embedded systems, systems/platform engineering, production reliability, and performance on memory-constrained Linux/ARM devices, with deep experience in concurrency, IPC, lifecycle management, crash root-cause analysis, and staged migrations.',
    'Operates at fleet scale, including technical ownership of an on-device feature-gating runtime serving billions of decisions per day across millions of devices and hundreds of gated features.',
    'Works across the device-to-cloud stack, spanning native systems (C++ services, daemons), applications (React Native), cloud services (Java, AWS), and platform concerns (backward compatibility, graceful degradation, observability, safe staged delivery).',
    'Provides senior technical leadership through multi-phase platform migrations, architecture and design reviews, cross-org debugging and dependency management, and mentoring engineers in production debugging, root-cause analysis, and on-call practices.',
  ],
  skills: [
    {
      id: 'programming-languages',
      name: 'Programming Languages',
      items:
        'C++ (C++17, RAII, smart pointers), Java (17, 21), Python, TypeScript/JavaScript (Node.js), Bash/POSIX shell scripting, C#, Kotlin, Swift, Rust (C FFI interop), SQL',
    },
    {
      id: 'embedded-and-systems',
      name: 'Embedded & Systems',
      items:
        'Embedded Linux, ARM, memory-constrained systems, Linux systems programming (POSIX signals, process lifecycle, file locking, procfs), IPC (IDL-defined interfaces, generated proxies/skeletons), multithreading and concurrency, object lifetime and teardown ordering, daemon supervision and watchdogs, crash recovery, cross-process state management, ELF shared-library linking and ABI compatibility, backward compatibility, graceful degradation and fallback design, core-dump/crash-log analysis (GDB, Breakpad), AddressSanitizer, ThreadSanitizer, UndefinedBehaviorSanitizer, firmware/OTA release engineering, release-branch integration and backports',
    },
    {
      id: 'cloud-and-infrastructure',
      name: 'Cloud & Infrastructure',
      items:
        'AWS (Lambda, Graviton, API Gateway, Step Functions, EventBridge, SQS, SNS, IAM, STS, VPC, PrivateLink, Route 53, Systems Manager Parameter Store, Secrets Manager, Kinesis, CloudWatch, DynamoDB, S3, ElastiCache), AWS CDK (TypeScript/IaC), CloudFormation, AWS SDK for C++, AWS SDK for Java 2.x, Boto3, AWS CLI, multi-region services, deployment pipelines, runbooks',
    },
    {
      id: 'application-and-client-platform',
      name: 'Application & Client Platform',
      items:
        'React Native, React, TypeScript/JavaScript client applications, C++ native modules, Hermes, Axios, Java Swing, FreeType, nlohmann/json, FastAPI, accessibility and screen-reader support, localization/internationalization (i18n), right-to-left layouts, multi-country launches, Android/iOS push-notification systems (APNs, FCM), Google Guice, Dagger, Jackson',
    },
    {
      id: 'data-stores',
      name: 'Data Stores',
      items: 'SQLite, DynamoDB, Redis/Valkey, ElastiCache, S3',
    },
    {
      id: 'build-and-release',
      name: 'Build & Release',
      items:
        'CMake, GNU Make, Gradle, npm, Git, GCC/Clang cross-compilation toolchains for ARM, CI/CD pipelines, release branching, JDK migrations (8→17→21), reproducible builds/hash-pinned dependencies, Coverity static analysis with build-blocking enforcement, feature flags and flag-gated rollouts, A/B testing infrastructure, shadow-mode validation',
    },
    {
      id: 'testing-and-quality',
      name: 'Testing & Quality',
      items: 'GoogleTest, GoogleMock, Catch2, JUnit 5, TestNG, Mockito, Jest',
    },
    {
      id: 'service-interfaces-and-protocols',
      name: 'Service Interfaces & Protocols',
      items: 'GraphQL, REST, RPC, HTTP, OAuth, curl',
    },
    {
      id: 'applied-ai',
      name: 'Applied AI',
      items:
        'Amazon Bedrock, Bedrock AgentCore, hosted LLMs, deterministic agent orchestration, hash-pinned prompts, model-output validation, token/cost measurement',
    },
  ],
  experience: [
    {
      id: 'amazon-kindle-senior-sde',
      employer: 'Amazon',
      title: 'Senior Software Development Engineer, Kindle',
      dates: 'Oct. 2024 - Present',
      highlights: [
        "Led Kindle's feature-gating migration and designed native daemons, reader features, and AWS services in C++, Java, and React Native.",
        'Coordinated milestone planning, design reviews, cross-org dependency tracking, and firmware launch readiness with experimentation-platform engineers, a principal engineer, principal technical program managers, and Kindle QA, delivering on schedule.',
        'Mentored 8+ engineers in C++, AWS, debugging, code reviews, and on-call analysis, helping 2 junior engineers earn promotions. Presented architecture designs and technical demonstrations covering feature gating, fleet reliability, content discovery, and Amazon Kids on Kindle to engineering, program, product, and UX stakeholders.',
      ],
      projects: [
        {
          id: 'feature-gating-platform-migration',
          name: 'Feature-Gating Platform Migration',
          highlights: [
            "Migrated Kindle's on-device feature-gating runtime from a retiring platform under a hard deadline, handling billions of daily decisions across millions of devices and hundreds of gated features, and ran a 30-task multi-phase program using code-search consumer audits, call-graph analysis, fleet telemetry, and feature-gate inventories, with named owners, critical-path planning, risk tracking, milestones, and escalation criteria.",
            "Built a C++ client for a partner team's Rust engine covering async callbacks, threading, identity, and lifetimes via partner-provided C ABI, opaque handles, RAII, ownership contracts, and bounded shutdown waits, validated 99.5% shadow-cutover agreement across millions of requests, with the other 0.5% traced to allocation refresh timing drift, not assignment logic, then evolved it into an always-on daemon with versioned IPC and no changes to 70+ downstream packages.",
            'Designed the daemon, client library, and Java-to-native bridge, implementing daemon lifecycle, crash recovery, concurrency, memory limits, and fallback from live allocations to the last downloaded database to compile-time defaults using atomic write-rename, achieving 14.3 MB p95 RSS, 0.1% mean CPU, 159 ms p90 cold start, and 0.05 ms p99 in-process lookup latency on 1 GB e-readers.',
            'Led a mid-level engineer implementing the client library and Java-to-native bridge, authored 60/102 release commits, and deployed the daemon at fleet scale.',
            'Rejected a kill-switch dependent on the subsystem it disabled, gating legacy retirement on a 22-row parity audit using decision-log diffing and shadow-traffic disagreement triage, with accepted gaps requiring written rationale and pre-retirement approval, while driving unit, API, cross-process, performance, stress, and crash-recovery testing.',
          ],
        },
        {
          id: 'production-reliability-and-ai-operational-reporting',
          name: 'Production Reliability & AI Operational Reporting',
          highlights: [
            "Root-caused production daemon failures through analysis of 244 fleet crash dumps, distinguishing supervisor hang kills from in-process failures using Breakpad backtraces, signal data, and process-state evidence. Fixed daemon-side defects and identified cross-org issues in database and networking components, cutting the daemon's crash rate nearly tenfold.",
            'Built daemon observability from scratch with 3 metric schemas across the daemon, assignment engine, and client library, covering lifecycle/supervisor events, startup latency, low-cardinality dimensions, and CloudWatch dashboards.',
            'Launched an AWS system from an empty account turning weekly telemetry data points into fleet health reports across IaC, pipelines, Lambda, API Gateway, Bedrock AgentCore, monitoring, canaries, guardrails, and deployed-infrastructure integration tests.',
            'Improved agent reliability with deterministic Step Functions orchestration, temperature 0 calls, schema-validated output, no retries for model/posting steps, tested numeric computation, rule-based publication, tool-less agent enforcement, and absent-versus-zero telemetry handling, achieving 95% reproducibility across runs.',
            'Audited the deployed system, uncovering 4 invariant failures including an account precondition validating the wrong AWS principal despite hundreds of passing tests, fixed each defect and the test gap that hid it, fenced untrusted prompt input, and made measurement provenance testable, exposing never-emitted metrics, biased ratios, and "empty" datasets caused by query limits.',
          ],
        },
        {
          id: 'kindle-reader-features-performance-and-identity',
          name: 'Kindle Reader Features, Performance & Identity',
          highlights: [
            'Restructured ownership of 3 delayed Reader features, delegating 1 and sequencing 2 behind feature flags, delivering 2 on the original date and the third later through direct support while building its dictionary-preference workflow and owning C++, React Native, remote configuration, accessibility, localization, and networking end to end.',
            'Built a C++ replacement for a shipping Java entitlement and content-acquisition service supporting Kindle Unlimited, Prime Reading, and purchase flows, using profile-keyed TTL caches, single-attempt borrow/purchase writes, duplicate-request suppression, account-change resets, queued acquisition serialization, and live-backend device validation.',
            'Root-caused UI responsiveness issues using Perfetto, per-render JavaScript timings, and native task timings; resolved scheduling contention without adding concurrency. Identified a reported +186% notebook regression as largely a measurement artifact and shipped a 17% improvement in notebook-open time.',
            "Triaged a release-blocking regression in another org's shared networking library using paired-unit flashing, firmware bisection, repeated A/B runs, and device-variance controls, reverted the upstream change, unblocked 2 firmware release pipelines, and backported 4 crash fixes across 3 shipping release lines.",
            'Consolidated Kindle account state into a C++ SDK as the source of truth, redesigning registration, sign-out, cache invalidation, and cross-process state handling, and delivered changes in revertible, device-tested phases.',
          ],
        },
        {
          id: 'generative-ai-handwriting-prototype',
          name: 'Generative-AI Handwriting Prototype',
          highlights: [
            'Prototyped an end-to-end system rendering hosted-LLM responses into ink on a handwriting e-reader, building 4 packages across 3 languages; the system integrated a Java Bedrock service on Lambda, IaC, monitoring, deployed integration tests, and a sole-authored on-device C++ ink library, with the full flow verified on physical hardware in an alpha deployment.',
            'Deterministically validated model tool calls before writing untrusted model output to customer-visible notebook state, allowlisting anchors, failing closed on invalid coordinates, capping replies, strokes, and turns, defining safety boundaries for geometry, placement, idempotency, and refusal, proving duplicate-ink risk through replay, and moving state and placement acknowledgments to the service.',
          ],
        },
        {
          id: 'amazon-kids-store-content-discovery-service',
          name: 'Amazon Kids Store Content-Discovery Service',
          highlights: [
            'Authored the design for a content-discovery service replacing a manually SQL-curated catalog, measuring duplicate/stale movies, missing recommended Kids titles, and 1.2 s p90 row generation through catalog-gap and latency analysis.',
            "Built a gateway integrating real-time recommendations, catalog, entitlement, and pricing through asynchronous list generation and GraphQL batch loaders. Enforced child safety by excluding purchasable titles from children's personalized recommendations, supporting non-personalized ordering, applying in-service filtering, and enabling emergency moderation.",
            'Planned capacity and storage for a service implemented by a teammate, sizing ElastiCache, DynamoDB, and S3 requirements and costs. The deployed service operated across multiple AWS regions; the busiest ran with zero errors over 14 days at 3× designed peak load and under half the latency budget.',
          ],
        },
        {
          id: 'organization-level-engineering',
          name: 'Organization-Level Engineering',
          highlights: [
            "Wired commercial C++ static analysis into Kindle's cross-compiled embedded build using compile_commands.json replay instead of blocked build interception, with package-only reporting, dependency-header filtering, and per-package exclusions, landing build-blocking enforcement across 164 build-configuration groups.",
            'Drafted a CI/CD consolidation strategy unifying 15 CI/release pipelines across 3 time zones, identifying authorization as the critical path, sequencing migrations by on-call ownership, and coordinating 20 teams.',
            'Reviewed cross-team embedded/platform work across C++, Java, React Native, Kotlin/Swift, build, and infrastructure for architecture, reliability, launch safety, concurrency, and privacy, addressed experimentation-platform issues, classified transient-to-persistent state failures, validated CI coverage, applied fail-unset defaults, and mentored engineers in root-cause analysis and on-call.',
          ],
        },
      ],
    },
    {
      id: 'amazon-kids-sde-2',
      employer: 'Amazon',
      title: 'Software Development Engineer II, Amazon Kids',
      dates: 'Jul. 2021 - Oct. 2024',
      highlights: [
        'Led a multi-year rewrite of Amazon Kids on Kindle from Java Swing to React Native/TypeScript over a C++ business-logic layer (an estimated 3-4 engineer-years, 4 engineers, 1 tester), passed org-level and Kindle senior-engineer design reviews, split delivery into 8 QA-ready milestones, and built the foundational Home architecture while mentoring and delegating to engineers.',
      ],
      projects: [
        {
          id: 'kindle-kids-home-rewrite',
          name: 'Kindle Kids Home Rewrite',
          highlights: [
            'Moved business logic into C++ behind React Native native modules and Djinni-generated interfaces using coarse per-page calls and promise-based async results, adding reversible flag-controlled coexistence with legacy code, driving the move from 5-minute polling to server push for consistency and battery life, and creating 4 team-owned packages to consolidate Kids logic from 7 legacy apps.',
            'Designed C++ Kids Home to exceed the legacy 10-row performance limit using server-driven pagination, next-page prefetch, and FlatList virtualization; verified performance at 300+ rows without degradation and reduced load time from 6.99 s to 3.48 s.',
            'Fixed device-freeze bugs, traced a release-blocking startup regression to serialized parallel work, and built on-device UI automation from scratch while owning the release pipeline and branching strategy.',
            'Led the 2023 on-site handoff to the Bangalore team: 5 recorded walkthroughs, 9 of 20 transition documents covering architecture, code, service APIs, local development, branching, build, and localization workflows, ownership of 10 of 26 handoff items, and supervised pairing on a handed-off milestone so the new team was building from the start; they launched the rewrite in July 2025.',
            'Built server-driven content, household/profiles, parental controls, offline, bedtime, and store access across a 2,000+ title catalog using JSON layout schema versioning, a widget type registry, unknown-type degradation, and client-side fallbacks, while driving accessibility across 5 disability cohorts and 15 customer journeys and remediating the Kids app and shared packages.',
          ],
        },
        {
          id: 'kindle-platform-shared-sdk',
          name: 'Kindle Platform / Shared SDK',
          highlights: [
            'Diagnosed a Kindle native SDK networking gap of 1,000-1,300 ms versus 250-500 ms via curl on identical hardware, built HTTP telemetry using libcurl DNS/TLS timers and per-attempt wall-clock timing, and drove fixes across networking, OAuth, device-info, and UI-framework components owned by other teams.',
            "Closed SDK gaps with a reusable Axios networking adapter and Kindle ports of the AWS SDK for C++ and Amazon's internal auth signer, hiding implementations behind cross-language provider and adapter interfaces so the platform networking library could later replace the SDK's HTTP client without changing callers.",
          ],
        },
        {
          id: 'parent-communications-push-notifications',
          name: 'Parent Communications / Push Notifications',
          highlights: [
            'Launched Amazon Kids parent app push notifications on Android and iOS with a 3-person team, resolving design questions in 3 weeks across sending, preferences, and in-app receipt, taking over an existing service and building first-run opt-in, supporting 6 notification types within months of launch.',
            'Owned the sending workstream, coordinating with engineers, QA, and 2 partner teams, rejecting Amazon Pinpoint over messaging policies, security and legal requirements, and last-mile ownership tradeoffs, authoring 6 of 9 team designs, working with Legal and UX on requirements for every notification type, and clearing Apple and Google policies with Legal for purchase-approval notifications.',
            "Migrated legacy notifications to Amazon's customer-messaging platform behind 1 dark-launched per-customer flag, validated dual send paths through integration tests and delivery-status checks, traced a push topic-ID/enum mismatch across 2 partner teams' systems and fixed it in 1 team's code, then cut over 100% of production traffic and removed legacy code, configuration, and IaC.",
            'Owned device-health notifications across 5 packages, adding SHA-256 idempotency and time-bucketed keys limiting battery alerts to once every 3 days and storage alerts every 2 weeks, then executing a staged 2-flag rollout across multiple countries.',
          ],
        },
      ],
    },
    {
      id: 'amazon-kids-sde-1',
      employer: 'Amazon',
      title: 'Software Development Engineer I, Amazon Kids',
      dates: 'Mar. 2020 - Jul. 2021',
      highlights: [
        'Owned the Kids+ subscription upsell card end to end from requirements through launch, including attribution metrics and an offline restart-loop fix, while serving as de facto operational owner for child-data privacy and logging issues and authoring the onboarding guide that ramped 2 engineers during COVID.',
        'Designed and largely solo-built the Kindle Kids setup rewrite from Java Swing to React Native over native C++ business logic in 4 months, using a framework new to the 2-engineer team and choosing C++ over Java/IPC for cleaner long-term ownership.',
        'Built the C++ device layer from first principles with service providers, platform wrappers, test seams, dependency injection, and server calls, creating reusable flows that merged 2 legacy setup paths into one and shipped in the factory image and on a new device at launch.',
        "Migrated the team's software from the legacy e-ink build environment to Amazon's standard Gradle-based infrastructure, cutting the build-deploy-test loop from over 10 minutes to under 30 seconds and authoring the migration guide adopted across the organization.",
      ],
      projects: [],
    },
    {
      id: 'rockstar-junior-gameplay-programmer',
      employer: 'Rockstar Games (Rockstar Toronto)',
      title: 'Junior Gameplay Programmer, Weapons Team',
      dates: 'Jan. 2020 - Mar. 2020',
      highlights: [
        "Owned sedative-ammunition development for Red Dead Online's Naturalist role, building configurable per-NPC dart tracking, time-decaying sedation, behavior/animation transitions, and compact replicated state to limit bandwidth, latency, and server CPU.",
        'Investigated and fixed gameplay bugs across weapon animations, projectiles, explosives, fluid interactions, NPC behavior, hit detection, and inverse kinematics, debugging related gameplay, animation, and weapon interactions in Red Dead Redemption 2 / Red Dead Online.',
        'Contributed to Grand Theft Auto VI (GTA VI).',
      ],
      projects: [],
    },
  ],
  education: [
    {
      id: 'carleton-bcs',
      school: 'Carleton University',
      degree: 'Bachelor of Computer Science',
      date: 'Apr. 2019',
    },
  ],
} as const satisfies Resume;
