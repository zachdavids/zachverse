# Phase 3 design inputs

From Phase 2's milestone 3, which verified the finished HTML portfolio (`docs/progress.md`, "Phase 2"). Phase 2's plan asks that outstanding items be documented at its exit; this file lists what Phase 2 leaves open for Phase 3's design. `docs/phase-2-inputs.md` stays the list for what Phase 1's review left: its "3D content" section and the 3D parts of "Rate limit" and "Compression" now apply to Phase 3, and its other items stay open unless its status section says otherwise.

## Measurement

- **Field data.** The site collects none, so INP, and LCP and CLS for real visits, are unknown (ADR 0010, "Limits"). Every performance figure Phase 2 records is a lab measurement.
- **Interaction latency.** Milestone 3 measured it once in a lab: the deep-dive toggles, tapped and keyboard-operated in Chromium as a phone with the CPU slowed 4×, took at most 56 ms against INP's target of 200 ms. Nothing runs that measurement on each change. Phase 3's controls (the camera, hotspots, and anything else a visitor drives) need an interaction check in CI that drives them with the CPU slowed and reads Event Timing, as milestone 3's measurement did.
- **Browsers.** CI's browser check runs Chromium only. Milestone 3 loaded every page once in WebKit and Firefox too, at 320, 768, and 1280 pixels and at 100% and 200% text size, with no sideways scrolling, overflow, or script error. A WebGL scene behaves differently from engine to engine, so Phase 3 needs per-engine checks of its own.

## Accessibility

- **Closed deep dives.** The browser check and Lighthouse load each long page with its deep dives closed, and axe-core treats a closed `details` element's content as hidden, so neither audits the deep dives' text. Milestone 3's automated layout probes opened them by script, but no axe-core audit ran with them open. If Phase 3 adds more collapsible content, open it in one audited load.
- **Review by a person.** Milestone 3's review covered one device: the owner used Safari on an iPhone 18 Pro Max, with VoiceOver over the home page and the case study, and found no problems (ADR 0010, "Limits"). No person checked a desktop browser, keyboard-only use, 200% text size, or Android; automated probes covered a desktop width and 200% text size in Chromium, WebKit, and Firefox, and keyboard use in Chromium only. Phase 3's scenes need a review of their own: each hotspot's keyboard and screen-reader path, and the HTML portfolio as the fallback.
- **Comprehension test.** Phase 2's plan asks for a five-second test in which at least four of five people name the owner's role and both employers, and says AI review is no substitute for it. At the owner's choice, milestone 3 simulated it with AI agents instead: five personas on a phone and on a desktop, each answering from what a five-second glance takes in, scored blind against a rule fixed in advance. All ten sessions passed, and the pull request has their answers. The simulation is not the plan's test, which is still to do with five people. Its one weak point was the fourth line, "Before Amazon, I was a gameplay programmer at Rockstar Games": a non-technical persona caught "Rockstar" but wasn't sure of it.

## Content

- **Dated claims.** "How this site is built" speaks as of October 2026, and the case study's "as of" claims describe Zach's role and work in progress then (ADR 0011, "Limits"). Each revision rechecks them.
- **Second case study.** Phase 2's plan allows one when approved material is ready; none was.
- **3D content.** The pages keep their facts in `src/content/`, so Phase 3's hotspots can show the same information (ADR 0010, "Content").

## Owner items

`docs/progress.md`, "Outstanding outside Phase 2's milestones", tracks what the owner does outside the milestones: the CAA record, the registrant-email check, and the owner's decisions on detection and response and on read-only access for agents.
