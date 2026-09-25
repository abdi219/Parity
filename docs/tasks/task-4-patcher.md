# Task 4: Patch Engine & Verification Loop

## Objective
Build `web/src/lib/patchEngine.ts` and wire up the re-audit flow.

## Requirements
- Generate unified markdown diffs showing exact line replacements for outdated docs.
- Add an "Apply Patch" button that updates documentation state in memory.
- Enable instant re-audit to verify unresolved drifts drop from 3 down to 0.