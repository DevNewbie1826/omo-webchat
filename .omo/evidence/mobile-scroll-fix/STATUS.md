# Evidence refreshed: REVISE

Dependencies are installed; baseline and after measurements exist. The frozen harness ran successfully, unchanged, and refreshed both screenshots. Current C1 and C2 FAIL; C3-C5 PASS. The separate real-browser settings sweep PASSes all eight font/width combinations. See verdict.md for exact thresholds and both result tables, and after/metrics-sweep.json for full numbers.

The yardstick SHA256 remains eed669df264cd1ae77346b5db2cf570945d2214985c2df08a6592f2c5a5ad556. Baseline uses constant 80; after uses the real estimator. This task changed evidence only, with the frozen runner's temporary server/core instrumentation restored in cleanup. Existing frontend working-tree edits belong to the parent task; verify-diffstat.log is a current tracked diff snapshot, not a clean-tree claim.

Both cleanup receipts show Vite stopped, temporary directory absent, core comparison exit 0, and port 5211 free. C6 tests/build were not rerun here. Desktop WebKit's forced iOS branch is not physical iOS verification. No git staging, commit, push or merge was performed.
