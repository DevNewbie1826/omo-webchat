# Stage 14 — C/D post-merge audit fixes

## Evidence
Ultrabrain deep audit (2026-09-04) of merged stages 12+13 returned REQUEST_CHANGES:
1 BLOCKER (oversized history discarded wholesale — motivating repo renders NO historical
activity; task 0B/oversized digest-110, DAG 0B/oversized, frontend ignores oversized+digests;
digest itself not byte-bounded — 3.1MiB from one record), 3 MAJOR (scan limits read old/
foreign-first and starve the DAG side; goal watcher not eventually consistent on reconnect/
transient/equal-stamp paths; activity history mount-hydrated not re-attach hydrated incl
recovery), 3 MINOR (unbounded unvalidated hydration FIFO; goal retry budget mismatch
4MiB/512KiB + missed pre-open replacement; ENOTDIR → 500). dagWaves NIT found already-fixed.

## Requirements
R1 bounded shelf packing: project only shelf-consumed fields, cap text fields, pack a
newest-first prefix into the 64KiB budget with truncated_* flags; byte-bound or remove
unused digests; realistic fixture asserting rendered task AND dag rows.
R2 bounded scan: batched newest-first enumeration, count every examined entry, independent
task/DAG budgets, no starvation; ENOTDIR treated as absent optional dir.
R3 goal watcher eventual consistency: explicit bind-time frame incl null, tri-state reads
(nil-result ≠ error), stamps acknowledged only after successful reads, existence seeded
from initial read, file identity (inode) in the stamp; caller-specific byte limit through
the stable-read seam with per-attempt revalidation.
R4 bind-generation hydration: /activity hydration keyed to successful binding generations
including recovery/reconnect (token arbiter retained); hydration FIFO validates recognized
activity events before buffering, marks superseded only on valid snapshots, bounded+coalesced.
R5 gates sequential green; stages 8/11/12/13 suites green.

## Constraints
Public text: live probing / own design attribution only.
