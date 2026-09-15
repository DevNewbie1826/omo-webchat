| Scenario | What was sent | What was observed | Result |
|---|---|---|---|
| failure-visible | errorMessage + stopReason:error | Exact failure text in error row | PASS |
| empty-error | errorMessage:""; stopReason:"error" | Exact row: error; full transcript: error; Turn failed absent | PASS |
| absent-error | No errorMessage; stopReason:"error" | Exact row: error; full transcript: error; Turn failed absent | PASS |
| legacy | Neither errorMessage nor stopReason | Ordinary legacy answer.; zero error rows | PASS |
| retry-sequence | Failure; auto_retry_start; auto_retry_end(success:false); final failure | Failure -> retrying -> retry failed -> final failure, in order | PASS |
| retry-fallback | All four retry_fallback_* kinds with messages | All four wire messages exact | PASS |
| continuation-error | continuation_error with message | Transcript notice carries exact message | PASS |
| no-false-alarm | User-cancelled stopReason:aborted; successful tool-only turn | Cancellation: 0 error rows; tool-only: 0 error rows | PASS |
| backward-compat | Text completion and empty completion without either new field | Original answer; 0 error rows; 0 empty placeholders | PASS |
