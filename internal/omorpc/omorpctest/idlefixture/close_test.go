package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

func TestCloseObservation(t *testing.T) {
	f := startFixture(t)
	control := &controls{daemon: f.daemon, root: t.TempDir()}
	state := httptest.NewRecorder()
	control.handler().ServeHTTP(state, httptest.NewRequest(http.MethodGet, "/state", nil))
	var initial map[string]any
	if err := json.Unmarshal(state.Body.Bytes(), &initial); err != nil {
		t.Fatal(err)
	}
	if initial["closeCount"] != float64(0) {
		t.Fatalf("closeCount = %v, want 0", initial["closeCount"])
	}

	// Subscribe before the actual RPC close. The response must describe the
	// completed close (not merely reception of its command) and inactive route.
	entered := make(chan struct{})
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		recorder := httptest.NewRecorder()
		close(entered)
		control.handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/close/await", bytes.NewBufferString(`{"count":1}`)))
		result <- recorder
	}()
	<-entered
	f.call(f.lead, omorpc.CloseSession{SessionID: f.rpcA})
	timer := time.NewTimer(fixtureAwait)
	defer timer.Stop()
	select {
	case response := <-result:
		if response.Code != http.StatusOK {
			t.Fatalf("status %d: %s", response.Code, response.Body.String())
		}
		var actual struct {
			Completed  bool `json:"completed"`
			CloseCount int  `json:"closeCount"`
			Sessions   []struct {
				Path string `json:"path"`
				Live bool   `json:"live"`
			} `json:"sessions"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &actual); err != nil {
			t.Fatal(err)
		}
		if !actual.Completed || actual.CloseCount != 1 {
			t.Fatalf("close result: %+v", actual)
		}
		found := false
		for _, session := range actual.Sessions {
			if session.Path == f.pathA {
				found = true
				if session.Live {
					t.Fatal("closed route remains live")
				}
			}
		}
		if !found {
			t.Fatal("closed route missing from snapshots")
		}
	case <-timer.C:
		t.Fatal("close observation did not complete")
	}
	state = httptest.NewRecorder()
	control.handler().ServeHTTP(state, httptest.NewRequest(http.MethodGet, "/state", nil))
	if err := json.Unmarshal(state.Body.Bytes(), &initial); err != nil {
		t.Fatal(err)
	}
	if initial["closeCount"] != float64(1) {
		t.Fatalf("closeCount = %v, want 1", initial["closeCount"])
	}
}

func TestCloseAwaitRejectsInvalidCount(t *testing.T) {
	for _, body := range []string{`{`, `{}`, `{"count":0}`, `{"count":-1}`, `{"count":"1"}`} {
		t.Run(body, func(t *testing.T) {
			response := httptest.NewRecorder()
			(&controls{}).handler().ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/close/await", bytes.NewBufferString(body)))
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status %d: %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestStateCountsParkedOpenRequests(t *testing.T) {
	f := startFixture(t)
	release := f.daemon.BlockHandlerForPath(omorpc.CmdOpenSession, "")
	defer release()
	completed := make(chan openResult, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), fixtureAwait)
		defer cancel()
		response, err := f.lead.Call(ctx, omorpc.OpenSession{CWD: t.TempDir()})
		result := openResult{err: err}
		if err == nil {
			result.err = json.Unmarshal(response.Data, &result.data)
		}
		completed <- result
	}()
	if !f.daemon.AwaitRequestCount(omorpc.CmdOpenSession, 3, fixtureAwait) {
		t.Fatal("open request not parked")
	}
	state := httptest.NewRecorder()
	(&controls{daemon: f.daemon}).handler().ServeHTTP(state, httptest.NewRequest(http.MethodGet, "/state", nil))
	var actual map[string]any
	if err := json.Unmarshal(state.Body.Bytes(), &actual); err != nil {
		t.Fatal(err)
	}
	if actual["openCount"] != float64(2) || actual["openRequestCount"] != float64(3) {
		t.Fatalf("parked open counters: %#v", actual)
	}
	release()
	f.awaitOpen(completed, "parked open")
}
