# Accumulated review lessons for rancher/qa-jenkins-library

# This file is loaded by pi-reviewer (scripts/pr-digest.mjs) on every digest run
# and injected as <review_rules> into the review prompt. It is NOT part of the
# upstream repo. Seed entries below; new lessons are appended by the digest
# automation when a review is marked useful.

## Seed lessons (2026-10-01)

- This is a Jenkins shared library (Groovy); changes to public vars/ methods are contracts for every Jenkinsfile that imports the library. Check rancherlabs/jenkins-job-builder for callers before approving signature changes.
- Slf4j/dependency bumps (renovate PRs) are usually safe but verify the lockfile and that no Jenkins plugin classloader pins a conflicting version.
