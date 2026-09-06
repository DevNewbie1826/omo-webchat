package omorpc

import (
	"errors"
	"io"
	"strings"
	"testing"
	"testing/iotest"
)

func TestOversizedEnvelopeFieldMatching(t *testing.T) {
	cases := []struct {
		name, header                     string
		wantID                           string
		wantNormalError, wantRecoverable bool
	}{
		{"nonfolding_dotted_I_is_not_request_ID", `"\u0130D":"r1","type":"response","command":"get_entries","success":true`, "", false, false},
		{"folding_long_s_malformed_success_is_not_ignorable", `"id":"r1","type":"response","command":"get_entries","success":true,"\u017fuccess":[]`, "", true, false},
		{"folding_long_s_valid_success", `"id":"r1","type":"response","command":"get_entries","\u017fuccess":true`, "r1", false, true},
		{"giant_unknown_member_before_metadata", `"extension":"` + strings.Repeat("z", 1<<20) + `","id":"r1","type":"response","command":"get_entries","success":true`, "r1", false, true},
		{"ascii_canonical", `"id":"r1","type":"response","command":"get_entries","success":true`, "r1", false, true},
		{"ascii_mixed_case", `"Id":"r1","TyPe":"response","CoMmAnD":"get_entries","SuCcEsS":true,"SeSsIoNiD":"rpc-a","ErRoR":""`, "r1", false, true},
		{"ascii_duplicate_id", `"id":"r1","ID":"r2","type":"response","command":"get_entries","success":true`, "r2", false, false},
		{"ascii_malformed_success", `"id":"r1","type":"response","command":"get_entries","SUCCESS":[]`, "", true, false},
		{"ascii_missing_id", `"type":"response","command":"get_entries","success":true`, "", false, false},
		{"ascii_unknown_member", `"extension":[],"id":"r1","type":"response","command":"get_entries","success":true`, "r1", false, true},
		{"unknown_dotted_I_alongside_real_id", `"\u0130D":"other","id":"r1","type":"response","command":"get_entries","success":true`, "r1", false, true},
		{"folding_long_s_duplicate_success", `"id":"r1","type":"response","command":"get_entries","success":true,"\u017fuccess":true`, "r1", false, false},
		{"folding_long_s_malformed_success_alone", `"id":"r1","type":"response","command":"get_entries","\u017fuccess":[]`, "", true, false},
		{"folding_long_s_malformed_session_id", `"id":"r1","type":"response","command":"get_entries","success":true,"\u017fessionId":[]`, "", true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			record := `{"data":"` + strings.Repeat("x", 8192) + `",` + tc.header + "}\n"
			ordinary, normalErr := DecodeLine([]byte(record))
			if (normalErr != nil) != tc.wantNormalError {
				t.Fatalf("normal decode error=%v", normalErr)
			}
			if !tc.wantNormalError && (ordinary.Response == nil || ordinary.Response.ID != tc.wantID || !ordinary.Response.Success) {
				t.Fatalf("normal decode metadata: want ID=%q and success=true", tc.wantID)
			}
			decoder := NewDecoderWithLimit(iotest.OneByteReader(strings.NewReader(record+`{"type":"agent_idle"}`+"\n")), 128)
			in, err := decoder.decode(true)
			if in != nil || !errors.Is(err, ErrFrameTooLarge) {
				t.Fatalf("oversized decode: inbound=%+v error=%v", in, err)
			}
			var oversized *oversizedHistoryError
			recoverable := errors.As(err, &oversized)
			t.Logf("ordinary error=%v, oversized error=%T: %v, recoverable=%v", normalErr, err, err, recoverable)
			if recoverable != tc.wantRecoverable {
				t.Errorf("recoverable=%v want=%v", recoverable, tc.wantRecoverable)
			}
			if recoverable {
				if oversized.id != tc.wantID || oversized.command != CmdGetEntries {
					t.Errorf("recovered metadata=%+v, want ID=%q command=%q", oversized, tc.wantID, CmdGetEntries)
				}
				in, nextErr := decoder.Decode()
				if nextErr != nil || in.Event == nil || in.Event.Type != "agent_idle" {
					t.Fatalf("next frame=%+v err=%v", in, nextErr)
				}
				if _, eofErr := decoder.Decode(); !errors.Is(eofErr, io.EOF) {
					t.Fatalf("EOF=%v", eofErr)
				}
			}
		})
	}
}

func TestClientOversizedUnknownUnicodeIDMustNotSettleRequest(t *testing.T) {
	c, peer, wire := oversizedPipe(t, 1024)
	token, events := c.CurrentEpoch()
	id, done := oversizedCall(t, c, wire, t.Context(), GetEntries{SessionID: "rpc-a"})
	record := strings.Replace(historyRecord(id, `"`+strings.Repeat("x", 8192)+`"`, true), `"id":`, `"\u0130D":`, 1)
	normal, err := DecodeLine([]byte(record))
	if err != nil || normal.Response.ID != "" {
		t.Fatalf("normal ID handling: error=%v; want empty ID", err)
	}
	if _, err := io.WriteString(peer, record); err != nil {
		t.Logf("wire write=%v", err)
	}
	got := oversizedResult(t, done)
	if !errors.Is(got.err, ErrDisconnected) || got.epoch != (EpochToken{}) || got.response != nil {
		t.Fatalf("uncorrelated record settled actual request: err=%T: %v, response=%+v, nonzero epoch=%v", got.err, got.err, got.response, got.epoch != (EpochToken{}))
	}
	awaitChannelClosed(t, events, testAwaitTimeout)
	if c.EpochCurrent(token) {
		t.Fatal("uncorrelated oversized record left epoch current")
	}
}
