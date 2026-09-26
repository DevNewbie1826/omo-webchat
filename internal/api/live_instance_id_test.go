package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/DevNewbie1826/omo-webchat/internal/auth"
)

func TestSessionsLiveInstanceIDStableWithinManager(t *testing.T) {
	// Given a running authenticated server with one manager.
	fixture := newCountsE2EFixture(t)

	// When the live endpoint is requested twice, even with no live rows.
	ids := make([]string, 2)
	for i := range ids {
		req, err := http.NewRequest(http.MethodGet, fixture.serverURL+"/api/sessions/live", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.AddCookie(&http.Cookie{Name: auth.CookieName, Value: fixture.token})
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var body struct {
			InstanceID string            `json:"instanceId"`
			Sessions   []json.RawMessage `json:"sessions"`
		}
		decodeErr := json.NewDecoder(resp.Body).Decode(&body)
		_ = resp.Body.Close()
		if decodeErr != nil {
			t.Fatal(decodeErr)
		}
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("live status = %d, want 200", resp.StatusCode)
		}
		if body.Sessions == nil {
			t.Fatal("live sessions must remain an array")
		}
		ids[i] = body.InstanceID
	}

	// Then the top-level epoch matches the manager and remains stable.
	if ids[0] == "" || ids[0] != fixture.manager.InstanceID() || ids[1] != ids[0] {
		t.Fatalf("live instance IDs = %q, %q; manager = %q", ids[0], ids[1], fixture.manager.InstanceID())
	}
}
