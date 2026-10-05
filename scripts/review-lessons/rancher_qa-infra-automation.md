# Accumulated review lessons for rancher/qa-infra-automation

# This file is loaded by pi-reviewer (scripts/pr-digest.mjs) on every digest run
# and injected as <review_rules> into the review prompt. It is NOT part of the
# upstream repo. Seed entries below; new lessons are appended by the digest
# automation when a review is marked useful.

## Seed lessons (2026-10-01)

- When a PR changes chart/registry URLs (releases.rancher.com -> charts.optimus.rancher.io), check EVERY job/file for missed occurrences; past PRs left stale RANCHER_VERSION defaults ("2.15.0") behind because occurrences span multiple Jenkins job blocks.
- Downstream consumers rancher/tests, rancher/distros-test-framework, and Jenkins jobs call these modules; flag any change to module inputs/outputs/inventory fields/env vars as a contract break needing a migration note.
- RANCHER_VERSION regex `/v?\d+\.\d+\.\d+/` governs repo fallback selection; free-form constraints like ">=0.0.0-0" silently change which chart repo (latest vs alpha) a run resolves to.
