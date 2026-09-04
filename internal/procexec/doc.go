// Package procexec exposes kernel-backed process-domain primitives for
// supervising child processes. Every answer comes from an OS kernel facility
// — POSIX process groups on Unix, Job Objects and process handles on Windows
// — never from heuristics such as process-table scans, name matching, or
// exit-code guessing.
//
// The package is deliberately tiny: it is the platform seam behind child-process
// domain control, so callers stay OS-agnostic while the kernel semantics stay
// exact per platform. TrackedProcess extends the seam to whole-tree teardown:
// on Windows the tree lives in a Job Object the kernel reaps on handle close,
// on Unix it is the process group addressed by the leader's pid.
package procexec

import "errors"

// ErrJobClosed reports a WaitTreeGone call on a TrackedProcess whose job
// handle Close already released: the kernel teardown started at close, but
// the wait can no longer observe the domain through the released handle, so
// an honest error replaces a fabricated drain result.
var ErrJobClosed = errors.New("job handle already closed")

// ErrTreeDrainTimeout reports that WaitTreeGone hit its deadline before the
// tracked domain drained conclusively. Callers classify with errors.Is
// instead of matching message text.
var ErrTreeDrainTimeout = errors.New("tracked tree drain timed out")
