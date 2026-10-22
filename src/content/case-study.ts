import type { Section } from './prose.ts';

// The flagship case study: the Kindle feature-gating migration, from Zach's résumé, his own record of the project,
// which isn't published, and his corrections to drafts. Where they differ, his corrections win, then the résumé. It
// keeps to what the record holds with confidence and to the split between his work and the team's, and gives only
// figures the résumé page already shows or that he supplied for this page, with scale in its round words.
// Zach approved this text line by line on 2026-10-22.

/**
 * The diagram: the stack before the migration, as the path from a C++ app to the assignment logic, and after it, as
 * the apps that share one daemon and the parts inside it.
 */
export interface Architecture {
  caption: string;
  /** The id of the section the diagram follows. */
  afterSection: string;
  before: { label: string; boxes: readonly string[]; note: string };
  after: {
    label: string;
    /** The processes that share the daemon. */
    consumers: readonly string[];
    /** The path from each app into the daemon. */
    boxes: readonly string[];
    /** The box that holds the daemon's parts, and the parts, in order. */
    container: string;
    parts: readonly string[];
    note: string;
  };
}

export interface CaseStudy {
  title: string;
  description: string;
  /** Where and when, as the line under the title gives it. */
  context: string;
  /** The three answers a reader skims first. */
  summary: { problem: string; owned: string; changed: string };
  sections: readonly Section[];
  diagram: Architecture;
}

export const caseStudy = {
  title: 'Kindle feature gating: a new engine behind the same API',
  description: "How I led Kindle's feature-gating migration off a retiring backend under a hard deadline: one supervised daemon behind the same API for 70+ packages.",
  context: 'Kindle, Amazon · 2026',
  summary: {
    problem: "Kindle e-reader apps turn hundreds of features on and off by asking which variant (treatment) of experiment X the device is in. The answer came from a client that relied on a backend the experimentation platform team was retiring. After the cutoff, old clients would get only fixed assignments and record no exposures (which variant each device saw), so experimentation would break. The deadline was hard and external. More than 70 packages called the client's C++ API, and several read paths bypassed it.",
    owned: "I led the migration and set its technical approach: keep the client's C++ API (the SDK façade), replace what's under it, and retire the old path only on evidence. I ran the work as a 30-task, multi-phase program, coordinating with experimentation-platform engineers, a principal engineer, principal technical program managers, and Kindle QA. I designed the client library, the Java-to-native bridge, and the daemon that runs the platform team's Rust engine in a single process. I implemented the C++ wrapper over the engine's C FFI and most of the daemon. A mid-level engineer I led implemented the client library and the bridge from my designs. As of October 2026, I'm the technical owner of Kindle's on-device feature-gating runtime.",
    changed: "The program delivered on schedule, and the migration is complete. In production, the new stack handled billions of assignment lookups a day on millions of devices, and none of the 70+ packages that call its API had to change. After launch, I root-caused daemon failures, fixed daemon-side defects, and identified cross-org issues, cutting the daemon's crash rate nearly tenfold.",
  },
  sections: [
    {
      id: 'context',
      heading: 'Context and constraints',
      paragraphs: [
        "The platform team's replacement was their Rust assignment engine, behind a C FFI. These constraints shaped what we built around it:",
      ],
      list: [
        'Compatibility: migrate existing consumers with zero or minimal code change, and keep Java and legacy IPC-bus consumers working during the transition.',
        "Device: embedded Linux, with a tens-of-MB memory ceiling in the device's process monitor.",
        "Delivery: silent over-the-air firmware releases, and a device can't practically be rolled back to an earlier one.",
        'Correctness: a stable, correct treatment per device; old-versus-new disagreement invisible to customers.',
        'Availability: never block app startup; the network at boot is unreliable.',
      ],
    },
    {
      id: 'keep-the-api',
      heading: "Keep the API, replace what's under it",
      paragraphs: [
        "A new API would have put a code change and a review on each of the 70+ packages that called the façade, against the same deadline. I kept the façade's public API and listener semantics and swapped the implementation behind them, starting with a C++ wrapper I built over the engine's C FFI. None of those packages had to change, and fixes land in one place.",
      ],
      list: [
        'Rejected: a new API; per-consumer adapter shims.',
        "Cost: the façade's quirks came along, like no unsubscribe and callbacks that don't say which experiment changed. I'd revisit the façade if its contract becomes the bottleneck.",
      ],
    },
    {
      id: 'daemon',
      heading: 'One daemon owns the engine',
      paragraphs: [
        "I incorporated single-process engine ownership into my daemon architecture, an approach the experimentation platform team also recommended. I wrote the daemon's high-level and low-level designs and evolved my wrapper into an always-on native daemon behind a versioned IPC interface.",
        "One process owns assignment state, networking, and telemetry, so consumers share one engine. On a memory-constrained device, that means one engine's memory instead of one per process. It also means one lifecycle to supervise and consumers decoupled behind a stable interface.",
        "With every consumer depending on that process, I designed how it starts, restarts, and degrades. Its IPC service registers only after the engine and the C++ provider initialize, so no call reaches an engine that isn't ready. That ordering doesn't help an app that starts before the daemon; early starts were one cause of boot-time races over start order and identity. A teammate moved the daemon's start trigger earlier for Java consumers, and I fixed the identity races.",
        "The init system restarts the daemon, and I gave it a memory ceiling in the process monitor. I implemented the lookup fallback for when live allocations aren't available: the last downloaded database (saved by atomic write-rename), then compile-time defaults.",
      ],
      list: [
        "Rejected: an engine in each app's process; hosting it in the Java app process.",
        "Cost: an extra process, an IPC hop for each lookup the in-process cache can't answer, and new boot-order dependencies.",
      ],
    },
    {
      id: 'leading',
      heading: 'How I led the migration',
      paragraphs: [
        "I mapped how apps read feature gates, with code-search consumer audits, call-graph analysis, fleet telemetry, and feature-gate inventories. The façade wasn't the only way in: a UI shell called the adapter directly, Java apps used the Java SDK, a React Native module had its own client, shell scripts used the legacy IPC bus, and an even older legacy client still existed. The migration covered those paths too, some by re-pointing what sat behind them and some by moving their consumers.",
        "The program had milestones, escalation criteria, and a named owner for each of its 30 tasks; I planned the critical path and tracked risks. I coordinated design reviews, cross-org dependencies, and firmware launch readiness across the teams involved, and I deployed the daemon at fleet scale.",
        "I handed off work as written designs and contracts: my designs for the client library and the bridge, which the mid-level engineer implemented; my specification for the old-versus-new validation layer, which another teammate implemented; and the listener contract I documented, which consumers inherited. Reviewing a consumer migration, I flagged a must-fix: a change handler that re-registered its listener each time it ran, which would have doubled the listener count on every allocation update. Teammates also retired the even older client, removed the legacy-backend path, and wrote most of the device integration tests.",
      ],
    },
    {
      id: 'beyond-my-team',
      heading: 'Beyond my team',
      paragraphs: [
        "Some of the work sat in another team's code. In the platform team's cross-compilation package for the device, I wrote most of the changes that got it building and linking, with their approval. It was the first Rust package to ship on the device, and it served as a template for other Kindle teams interested in Rust.",
        "I identified the need to retire obsolete feature gates after launch and removed 30 gates and their associated dead code. I defined the requirements for an organization-wide dashboard tracking feature-gate state and ownership, which a teammate implemented. As of October 2026, I'm designing a tool that automates dead-code removal for our organization.",
      ],
    },
    {
      id: 'retire-on-evidence',
      heading: 'Retire the old path on evidence',
      paragraphs: [
        "Disagreement between old and new had to stay invisible to customers, and a retirement shipped in firmware couldn't be undone device by device, so I gated retirement of the old path on evidence. Before retirement, the new path shadowed the legacy implementation, returning the legacy answer while recording disagreements for investigation. I used those results and a structured parity review to establish the retirement criteria.",
        'The gate was a 22-row parity audit, built from decision-log diffs and triage of shadow-traffic disagreements.',
      ],
      list: [
        'Rejected: a kill switch that depended on the subsystem it was meant to disable.',
        'Cost: every gap we accepted needed a written rationale and approval before retirement.',
      ],
    },
    {
      id: 'reliability',
      heading: 'Reliability and evidence',
      paragraphs: [
        "On device, the daemon's measured steady-state memory was comfortably below the process monitor's tens-of-MB ceiling, and its average CPU was well under one percent. It went from launch to its ready event in a fraction of a second at p90, and in-process lookups took under a millisecond at p99. Neither timing is end to end: the startup figure is the daemon's own, not readiness as apps see it, and the lookup figure excludes lookups that cross IPC to the daemon.",
        "I drove unit, API, cross-process, performance, stress, and crash-recovery testing, and built the daemon's observability from scratch: 3 metric schemas across the daemon, the engine, and the client library.",
        "In stress tests on a virtual device, the daemon's tail latency missed the target set for hardware, and I reported the miss as a negative result. It's a virtual-device result, not a hardware measurement.",
        "After launch, I triaged the daemon's crash records, separating benign lifecycle terminations from genuine faults, and analyzed 244 fleet crash dumps to tell supervisor hang kills from in-process failures. I fixed daemon-side defects and took each cross-org issue, in database and networking components, to its owning team with a hardening proposal. The daemon's crash rate fell nearly tenfold.",
        "To test a theory that the daemon was being killed for memory, I measured it on a physical device, where it had ample headroom. The memory-kill path I traced in the process monitor was gated on system-wide memory pressure, so a higher limit would mostly change which process got culled; I recommended diagnosing the kills before raising it.",
      ],
    },
    {
      id: 'lessons',
      heading: 'Trade-offs and lessons',
      paragraphs: [],
      list: [
        "The boot-time races were a gap in my design. Next time, I'd map who writes what, and when, up front.",
        "A green signal is only as good as what it measures. Host-build line coverage was high, but device-only code isn't compiled on the host, so I documented that coverage overstated device confidence.",
      ],
    },
    {
      id: 'deep-dive-ffi-boundary',
      heading: 'Deep dive: the FFI boundary and the listener contract',
      deepDive: true,
      paragraphs: [
        "Inside the daemon, the engine's callbacks arrive asynchronously, so my wrapper keeps the C FFI boundary strict. It owns the engine's opaque handles through RAII, lets no exception or stack unwinding cross into C, copies strings and buffers at the boundary, guards every callback against its owner having been destroyed, and bounds its waits at shutdown.",
        "In each app, under the façade's listener contract, callbacks run on the IPC dispatch thread for every allocation update and carry no experiment id, so each subscription filters for its own. A lookup inside a callback is a blocking IPC call on that dispatch thread, a stall risk the contract documents. There's no unsubscribe, so a handler must capture a weak reference to its owner.",
        "That's why the re-registering listener was a must-fix. With no deduplication and no unsubscribe, that doubling would have grown memory, exhausted IPC channels, and multiplied blocking calls. The fix registers exactly once.",
      ],
    },
    {
      id: 'deep-dive-daemon-lifecycle',
      heading: "Deep dive: the daemon's lifecycle",
      deepDive: true,
      paragraphs: [
        "I based the daemon's process model on an existing headless native service on the same platform and wrote down where it deviates. The init system starts it and respawns it if it dies. It runs as a singleton and loads no UI toolkit.",
        'Startup order is fixed and RAII-guarded, a ready event tells dependents when startup is done, and shutdown runs in reverse.',
        'I chose sigwait over asynchronous signal handlers: termination signals are blocked in every thread and consumed synchronously on a dedicated thread, which the main thread waits on. That keeps async-signal-safety concerns out of the rest of the code.',
        'Besides the memory ceiling, the process monitor checks a heartbeat.',
      ],
    },
    {
      id: 'deep-dive-evidence',
      heading: 'Deep dive: how the evidence was gathered',
      deepDive: true,
      paragraphs: [
        "Stress tests ran on a virtual device. One run made hundreds of thousands of IPC calls, and its memory drift stayed within the test's own pass threshold, which isn't a product guardrail.",
        "The 3 metric schemas cover lifecycle and supervisor events and startup latency, with low-cardinality dimensions and CloudWatch dashboards.",
        'The billions-a-day lookup figure is a floor, from a production lookup counter. To tell hang kills from in-process failures, I used Breakpad backtraces, signal data, and process state.',
        "For the memory theory, I measured RSS, the high-water mark, and private-dirty versus clean shared pages on one device, so the headroom it showed is that device's, not the fleet's.",
      ],
    },
  ],
  diagram: {
    caption: 'How a C++ app reaches the assignment logic, before and after.',
    afterSection: 'context',
    before: {
      label: 'Before',
      boxes: ['C++ app', 'SDK façade', 'Native adapter', 'Legacy IPC bus', 'Java SDK (in the Java app process)'],
      note: 'The Java SDK owned downloads, exposure flushing, and server calls to the legacy backend over HTTPS. Java apps called it directly, and several read paths bypassed the façade.',
    },
    after: {
      label: 'After',
      consumers: ['Reader app', 'Document renderer', 'Setup process'],
      boxes: ['SDK façade in each app (same API, IPC client inside)'],
      container: 'Experimentation daemon (one supervised process)',
      parts: [
        'IPC server',
        'C++ provider (identity, configuration, account events)',
        'C++ wrapper (C FFI)',
        'Rust assignment engine (platform team)',
      ],
      note: "The engine owns downloads, local storage, assignment, and exposure upload. Lookups are cached in each app's process where possible. The init system and the process monitor supervise the daemon. Java consumers reach it through the Java-to-native bridge.",
    },
  },
} as const satisfies CaseStudy;
