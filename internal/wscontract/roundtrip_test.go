package wscontract

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"
)

// fixturesDir avoids source-file paths, which are rewritten by -trimpath.
// An override supports packaged tests; repository runs discover from CWD or
// the test executable location.
func fixturesDir(t *testing.T) string {
	t.Helper()
	if override := os.Getenv("WS_CONTRACT_FIXTURES"); override != "" {
		if info, err := os.Stat(override); err == nil && info.IsDir() {
			return override
		}
		t.Fatalf("WS_CONTRACT_FIXTURES=%q is not a directory", override)
	}
	find := func(start string) string {
		for dir := start; ; dir = filepath.Dir(dir) {
			candidate := filepath.Join(dir, "contract", "fixtures")
			if info, err := os.Stat(candidate); err == nil && info.IsDir() {
				return candidate
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				return ""
			}
		}
	}
	if cwd, err := os.Getwd(); err == nil {
		if found := find(cwd); found != "" {
			return found
		}
	}
	if executable, err := os.Executable(); err == nil {
		if found := find(filepath.Dir(executable)); found != "" {
			return found
		}
	}
	t.Fatal("cannot locate contract/fixtures (set WS_CONTRACT_FIXTURES)")
	return ""
}

type fixture struct {
	name string
	data []byte
}

func loadFixtures(t *testing.T) []fixture {
	t.Helper()
	dir := fixturesDir(t)
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read fixtures dir: %v", err)
	}
	var out []fixture
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			t.Fatalf("read %s: %v", e.Name(), err)
		}
		out = append(out, fixture{name: e.Name(), data: data})
	}
	if len(out) == 0 {
		t.Fatal("no fixtures found")
	}
	return out
}

// assertRoundtrip re-marshals the decoded frame and compares it to the fixture
// semantically (JSON-normalized), proving the generated Go types carry every
// field in the fixture without loss or invention.
func assertRoundtrip(t *testing.T, name string, data []byte, frame any, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("%s: parse: %v", name, err)
	}
	remarshaled, err := json.Marshal(frame)
	if err != nil {
		t.Fatalf("%s: marshal: %v", name, err)
	}
	var want, got any
	if err := json.Unmarshal(data, &want); err != nil {
		t.Fatalf("%s: fixture JSON: %v", name, err)
	}
	if err := json.Unmarshal(remarshaled, &got); err != nil {
		t.Fatalf("%s: remarshaled JSON: %v", name, err)
	}
	if !reflect.DeepEqual(want, got) {
		t.Fatalf("%s: roundtrip mismatch\n want: %s\n got:  %s", name, data, remarshaled)
	}
}

func TestServerFrameFixturesRoundtrip(t *testing.T) {
	for _, fx := range loadFixtures(t) {
		if !strings.HasPrefix(fx.name, "server-") && !isKnownTypeTolerant(fx.name) {
			continue
		}
		frame, err := ParseServerFrame(fx.data)
		assertRoundtrip(t, fx.name, fx.data, frame, err)
	}
}

func TestClientFrameFixturesRoundtrip(t *testing.T) {
	for _, fx := range loadFixtures(t) {
		if !strings.HasPrefix(fx.name, "client-") {
			continue
		}
		frame, err := ParseClientFrame(fx.data)
		assertRoundtrip(t, fx.name, fx.data, frame, err)
	}
}

func TestUnsupportedProviderErrorFixture(t *testing.T) {
	const name = "server-error-unsupported-provider.json"
	data, err := os.ReadFile(filepath.Join(fixturesDir(t), name))
	if err != nil {
		t.Fatal(err)
	}
	frame, err := ParseServerFrame(data)
	assertRoundtrip(t, name, data, frame, err)
	errorFrame, ok := frame.(*ErrorFrame)
	if !ok || errorFrame.Code == nil || *errorFrame.Code != ErrorCodeUnsupportedProvider {
		t.Fatalf("parsed frame code = %v, want %q", errorFrame, ErrorCodeUnsupportedProvider)
	}
}

func TestInvalidFixturesAreRejected(t *testing.T) {
	for _, test := range []struct {
		name   string
		server bool
	}{
		{name: "invalid-server-hello-missing-required.json", server: true},
		{name: "invalid-client-run-kind.json"},
	} {
		data, err := os.ReadFile(filepath.Join(fixturesDir(t), test.name))
		if err != nil {
			t.Fatal(err)
		}
		if test.server {
			_, err = ParseServerFrame(data)
		} else {
			_, err = ParseClientFrame(data)
		}
		if err == nil {
			t.Errorf("%s: malformed known frame parsed successfully", test.name)
		}
	}
}

func TestKnownFramePreservesAdditionalProperties(t *testing.T) {
	data := []byte(`{"type":"hello","version":2,"serverVersion":"v2","future":{"enabled":true}}`)
	frame, err := ParseServerFrame(data)
	assertRoundtrip(t, "known-extra", data, frame, err)
}

// isKnownTypeTolerant selects tolerant-* fixtures whose wire type IS in the
// closed union (minimal-but-valid frames: ack without sessionId, empty final
// entries page, error with only code+message).
func isKnownTypeTolerant(name string) bool {
	return strings.HasPrefix(name, "tolerant-") && !strings.Contains(name, "unknown")
}

func TestUnknownFramePassthrough(t *testing.T) {
	var unknownFixture []byte
	for _, fx := range loadFixtures(t) {
		if strings.Contains(fx.name, "unknown") {
			unknownFixture = fx.data
			break
		}
	}
	if unknownFixture == nil {
		t.Fatal("no unknown-frame fixture")
	}
	var probe struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(unknownFixture, &probe); err != nil {
		t.Fatal(err)
	}
	if probe.Type == "" || slices.Contains(ServerFrameTypes(), probe.Type) || slices.Contains(ClientFrameTypes(), probe.Type) {
		t.Fatalf("fixture must carry a type outside both closed unions, got %q", probe.Type)
	}
	// Forward compatibility (R1): unknown type decodes lossily-but-safely into
	// UnknownFrame, never into a known struct, and never fails the parse.
	frame, err := ParseServerFrame(unknownFixture)
	if err != nil {
		t.Fatalf("unknown frame must not fail the parse: %v", err)
	}
	u, ok := frame.(UnknownFrame)
	if !ok {
		t.Fatalf("expected UnknownFrame, got %T", frame)
	}
	if u.Type != probe.Type {
		t.Fatalf("UnknownFrame.Type = %q, want %q", u.Type, probe.Type)
	}
	assertRoundtrip(t, "unknown", unknownFixture, u, nil)
}

func TestEveryFixtureKindHasFixture(t *testing.T) {
	dir := fixturesDir(t)
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var bodies []string
	for _, e := range entries {
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		bodies = append(bodies, string(data))
	}
	for _, wire := range ServerFrameTypes() {
		if !slices.ContainsFunc(bodies, func(b string) bool { return strings.Contains(b, `"type": "`+wire+`"`) }) {
			t.Errorf("no fixture for server wire type %q", wire)
		}
	}
	for _, wire := range ClientFrameTypes() {
		if !slices.ContainsFunc(bodies, func(b string) bool { return strings.Contains(b, `"type": "`+wire+`"`) }) {
			t.Errorf("no fixture for client wire type %q", wire)
		}
	}
}

// TestWireNameMappingIsTotal pins the bridge-owned mapping: every v2 session
// FrameKind (20, from internal/session/stub.go) maps to a known server wire type.
func TestWireNameMappingIsTotal(t *testing.T) {
	frameKinds := []string{
		"ready", "message.delta", "message", "tool", "state", "name", "stats",
		"models", "commands", "entries", "compaction.started", "compaction.done",
		"control.result", "ack", "approval", "notice", "extensionEvent", "error",
		"run.started", "run.done",
	}
	serverTypes := ServerFrameTypes()
	if len(FrameKindToWireName) != len(frameKinds) {
		t.Fatalf("FrameKindToWireName has %d entries, want %d", len(FrameKindToWireName), len(frameKinds))
	}
	for _, kind := range frameKinds {
		wire, ok := FrameKindToWireName[kind]
		if !ok {
			t.Errorf("no wire name for FrameKind %q", kind)
			continue
		}
		if !slices.Contains(serverTypes, wire) {
			t.Errorf("FrameKind %q maps to %q, which is not a server wire type", kind, wire)
		}
	}
	for _, cmd := range ClientWireNames {
		if !slices.Contains(ClientFrameTypes(), cmd) {
			t.Errorf("client wire name %q not in closed client union", cmd)
		}
	}
}

// TestContractRequirements pins the schema-level requirements R1-R20 that are
// checkable without a peer: entries.final required, error codes closed,
// notice.at RFC3339Nano, resume_failed candidates, hello version envelope.
func TestContractRequirements(t *testing.T) {
	dir := fixturesDir(t)
	read := func(name string) map[string]any {
		t.Helper()
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatalf("fixture %s: %v", name, err)
		}
		var m map[string]any
		if err := json.Unmarshal(data, &m); err != nil {
			t.Fatalf("fixture %s: %v", name, err)
		}
		return m
	}

	// entries: final REQUIRED on every frame (invariant 18).
	for _, name := range []string{"server-entries.json", "tolerant-entries-empty-final.json"} {
		if _, ok := read(name)["final"]; !ok {
			t.Errorf("%s: entries fixture must carry final", name)
		}
	}

	// error: closed code enum + required message; resume_failed carries
	// dangling + candidates (invariant 7).
	errFrame := read("server-error.json")
	if errFrame["code"] != ErrorCodeResumeFailed {
		t.Errorf("error fixture code = %v, want %v", errFrame["code"], ErrorCodeResumeFailed)
	}
	if errFrame["dangling"] != true || errFrame["candidates"] == nil {
		t.Error("resume_failed fixture must carry dangling and candidates")
	}
	if m, ok := read("tolerant-error-minimal.json")["message"].(string); !ok || m == "" {
		t.Error("error message is required")
	}

	// notice: at is RFC3339Nano on every notice (invariant 14).
	at, _ := read("server-notice.json")["at"].(string)
	if _, err := time.Parse(time.RFC3339Nano, at); err != nil {
		t.Errorf("notice at %q is not RFC3339Nano: %v", at, err)
	}

	// hello: version envelope.
	hello := read("server-hello.json")
	if v, _ := hello["version"].(float64); v < 1 {
		t.Errorf("hello version = %v, want >= 1", hello["version"])
	}
	if _, ok := hello["serverVersion"].(string); !ok {
		t.Error("hello serverVersion is required")
	}
}

// TestNoticeRFC3339NanoShape documents the wire shape the parser converts:
// nanosecond precision survives as a string on the wire.
func TestNoticeRFC3339NanoShape(t *testing.T) {
	rfc3339Nano := regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$`)
	for _, fx := range loadFixtures(t) {
		var f NoticeFrame
		if err := json.Unmarshal(fx.data, &f); err != nil || f.Type != "notice" {
			continue
		}
		if !rfc3339Nano.MatchString(f.At) {
			t.Errorf("%s: notice at %q not RFC3339Nano-shaped", fx.name, f.At)
		}
	}
}
