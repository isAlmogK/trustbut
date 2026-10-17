# Honest README: claims that match the measurements

**Status:** Implemented (2026-10-18)
**Feature:** trustbut-index results `results/pilot-2026-10-17` (labels) and `results/pilot-2026-10-17-0.7.0` in [trustbut-index](https://github.com/isAlmogK/trustbut-index). This spec covers the trustbut README and roadmap only. No code changes.

## Problem

The README promises more than the measurements show:

- The pitch is "shows you what's actually true" about agents that skip tests, delete assertions and fake green suites. On 201 real PRs (trustbut 0.7.0), no PR, agent or human, had a test that passed at base and failed at head, and agents' new or changed tests failed without the change more often than humans' (97% vs 88%).
- In the 0.6.0 pilot labels, 5 of 71 findings (7%) were worth a reviewer acting on. Most were true but benign.
- "Field results" is three anecdotes from the author's own repos.
- The FAQ says a review "takes minutes, not an hour", which nothing measured.
- Three notes still say "until 0.3.0 is on npm"; 0.7.0 is published.

## Positioning

A **proof checker**: trustbut reruns your tests in a clean checkout and shows whether any new or changed test fails without the change. The agent hook keeps the agent working while the receipt is FAIL. Research on agents exploiting tests stays as background, with a pointer to what we measured.

## Changes

1. **Header and intro:** tagline "Does anything prove this change?". Intro describes the clean rerun, the before/after proof, the integrity and escape flags, and the hook. Keep the example receipt.
2. **Why I'm building this:** keep the problem (checking agent work is the slow part) and the surveys. Keep the lab research as background and say that in real PRs we rarely saw these behaviours. Drop "more useful, not less".
3. **Replace "Field results" with "What we've measured":** the 0.7.0 run numbers (coverage, zero regressions, proof rates, findings per group), the 0.6.0 label precision with its caveats (Claude-drafted, not human-confirmed, not fully blinded), what 0.7.0 changed, and what isn't measured yet (`change-not-proven` precision, the hook in the agent loop). One line for the author's own repos.
4. **What it checks:** one line saying integrity and escape findings are things to scan, not verdicts.
5. **FAQ:** drop the "minutes, not an hour" claim; add "Do agents actually cheat on tests?".
6. **Stale notes:** remove the three "until 0.3.0" notes.
7. **Roadmap:** README roadmap lists 0.5 to 0.7 and marks the honesty index as a study in progress. `docs/ROADMAP.md` v0.5 row gets the same status.

## Out of scope

- Reference sections (install, usage, config, CI inputs, hooks) beyond the stale notes.
- The empty `all-agents` group in trustbut-index's `aggregate.json`, a trustbut-index bug fixed there.

## As built

- The FAQ answer to "Is it a replacement for code review?" now also says trustbut doesn't judge whether a change is correct or well designed.
- The `docs/ROADMAP.md` v0.5 row also says a public index follows only if the study shows the findings are worth acting on, and names the 0.5 to 0.7 releases that came out of the pilot.
- The Install and CI notes about 0.3.0 were removed entirely; the hook note keeps its first sentence (install globally).
