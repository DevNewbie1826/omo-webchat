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
