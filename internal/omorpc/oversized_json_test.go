package omorpc

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
	"testing/iotest"
)

func checkDiscardedJSON(t *testing.T, data string) {
	t.Helper()
	record := historyRecord("r1", data+strings.Repeat(" ", 1024), true)
	want := json.Valid([]byte(record)) && !strings.Contains(data, "\n")
	d := NewDecoderWithLimit(iotest.OneByteReader(strings.NewReader(record+`{"type":"agent_idle"}`+"\n")), 128)
	_, err := d.decode(true)
	var oversized *oversizedHistoryError
	if got := errors.As(err, &oversized); got != want {
		t.Fatalf("data %q: recoverable=%v want=%v, error=%v", data, got, want, err)
	}
	if want {
		if oversized.id != "r1" || oversized.command != CmdGetEntries {
			t.Fatalf("metadata = %+v", oversized)
		}
		in, err := d.Decode()
		if err != nil || in.Event == nil || in.Event.Type != "agent_idle" {
			t.Fatalf("following event = %+v, %v", in, err)
		}
	}
}

func TestOversizedJSONMatchesStandardValidation(t *testing.T) {
	for _, data := range []string{
		`null`, `true`, `false`, `0`, `-0`, `1.25e-20`, `[{},[],"x",true,false,null,1]`,
		`"\"\\\/\b\f\n\r\t\u0000\uD834\uDD1E"`, `"` + string([]byte{0xff}) + `"`,
		`{"id":"fake","nested":{"data":[1,2,3]}}`,
		``, `01`, `-`, `1.`, `1e`, `1e+`, `NaN`, `+1`, `TRUE`, `[1,]`, `{"a":1,}`,
		`{"a" 1}`, `{"a":}`, `[1 2]`, `"\q"`, `"\u12xz"`, `"unfinished`,
		`"bad` + string([]byte{0}) + `"`, `{} {}`, `[1` + "\n" + `,2]`,
	} {
		checkDiscardedJSON(t, data)
	}
	// Deterministic mutations exercise delimiters, escapes, and number grammar.
	seed := `{"x":[-1.25e+3,true,false,null,"a\u1234\"b",{},[]]}`
	for i := range len(seed) {
		checkDiscardedJSON(t, seed[:i]+seed[i+1:])
		for _, ch := range []byte{'"', '\\', ',', ':', '}', ']', '0', 'e', ' ', 0} {
			checkDiscardedJSON(t, seed[:i]+string(ch)+seed[i+1:])
		}
	}
}

func FuzzOversizedHistoryJSON(f *testing.F) {
	for _, seed := range []string{`null`, `{"x":[1,-2.3e+4,true,"\u1234"]}`, `[1,]`, `"\q"`, `"\u12xz"`} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, data string) {
		if len(data) > 8192 {
			return
		}
		checkDiscardedJSON(t, data)
	})
}

func TestOversizedEnvelopeMemberOrders(t *testing.T) {
	members := []string{`"id":"r1"`, `"type":"response"`, `"command":"get_entries"`, `"success":true`, `"sessionId":"rpc-a"`, `"data":"` + strings.Repeat("x", 1024) + `"`}
	var visit func(int)
	visit = func(i int) {
		if i < len(members) {
			for j := i; j < len(members); j++ {
				members[i], members[j] = members[j], members[i]
				visit(i + 1)
				members[i], members[j] = members[j], members[i]
			}
			return
		}
		record := `{` + strings.Join(members, ",") + "}\r\n"
		d := NewDecoderWithLimit(strings.NewReader(record), 128)
		_, err := d.decode(true)
		var oversized *oversizedHistoryError
		if !errors.As(err, &oversized) || oversized.id != "r1" {
			t.Fatalf("order: %v", err)
		}
		if _, err := d.Decode(); !errors.Is(err, io.EOF) {
			t.Fatalf("alignment: %v", err)
		}
	}
	visit(0)
}

func TestOversizedEnvelopeRejectsAmbiguousMetadata(t *testing.T) {
	for _, header := range []string{
		`"id":"r1","ID":"r2","type":"response","command":"get_entries","success":true`,
		`"id":"r1","type":"response","command":"get_entries","success":true,"success":false`,
		`"id":"r1","type":"response","command":"get_entries"`,
		`"id":123,"type":"response","command":"get_entries","success":true`,
		`"id":"r1","type":"response","command":"get_entries","success":null`,
		`"id":"r1","type":"response","command":"get_entries","success":true,"error":[]`,
		`"id":"` + strings.Repeat("x", 65536) + `","type":"response","command":"get_entries","success":true`,
		`"` + strings.Repeat("k", 65536) + `":0`,
	} {
		d := NewDecoderWithLimit(strings.NewReader(`{"data":"`+strings.Repeat("x", 1024)+`",`+header+"}\n"), 128)
		_, err := d.decode(true)
		var oversized *oversizedHistoryError
		if !errors.Is(err, ErrFrameTooLarge) || errors.As(err, &oversized) {
			t.Fatalf("ambiguous metadata accepted: %v", err)
		}
	}
}

func TestOversizedJSONDepthLimit(t *testing.T) {
	for _, depth := range []int{9999, 10000} {
		record := historyRecord("r1", strings.Repeat("[", depth)+"0"+strings.Repeat("]", depth), true)
		d := NewDecoderWithLimit(strings.NewReader(record), 128)
		_, err := d.decode(true)
		var oversized *oversizedHistoryError
		if errors.As(err, &oversized) != json.Valid([]byte(record)) {
			t.Fatalf("depth %d: %v", depth, err)
		}
	}
}

// Generate the giant field without storing it in the fixture or the decoder.
type repeatedHistoryByte struct{}

func (repeatedHistoryByte) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = 'x'
	}
	return len(p), nil
}

func BenchmarkOversizedHistoryGiantField(b *testing.B) {
	for _, size := range []int64{8 << 20, 64 << 20} {
		b.Run(fmt.Sprintf("%dMiB", size>>20), func(b *testing.B) {
			b.ReportAllocs()
			b.SetBytes(size)
			for b.Loop() {
				wire := io.MultiReader(strings.NewReader(`{"data":"`), io.LimitReader(repeatedHistoryByte{}, size), strings.NewReader(`","id":"r1","type":"response","command":"get_entries","success":true}`+"\n"))
				d := NewDecoder(wire)
				_, err := d.decode(true)
				var oversized *oversizedHistoryError
				if !errors.As(err, &oversized) {
					b.Fatal(err)
				}
			}
		})
	}
}
