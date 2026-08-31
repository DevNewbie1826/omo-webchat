package chat

import "testing"

func TestNormalizePersistedProvider(t *testing.T) {
	cases := []struct {
		name      string
		persisted string
		want      string
		wantErr   bool
	}{
		{name: "empty is pre-provider legacy", persisted: "", want: "omo"},
		{name: "senpi is the pre-rebrand identity", persisted: "senpi", want: "omo"},
		{name: "omo is canonical", persisted: "omo", want: "omo"},
		{name: "omp is not resumable", persisted: "omp", wantErr: true},
		{name: "unknown identity", persisted: "claude", wantErr: true},
		{name: "case variant is not an alias", persisted: "Omo", wantErr: true},
		{name: "whitespace is not an alias", persisted: " senpi", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := NormalizePersistedProvider(tc.persisted)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("NormalizePersistedProvider(%q) = %q, want rejection", tc.persisted, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("NormalizePersistedProvider(%q) error: %v", tc.persisted, err)
			}
			if got != tc.want {
				t.Fatalf("NormalizePersistedProvider(%q) = %q, want %q", tc.persisted, got, tc.want)
			}
		})
	}
}

func TestNormalizePersistedProviderResultIsLaunchable(t *testing.T) {
	for _, persisted := range []string{"", "senpi", "omo"} {
		launchable, err := NormalizePersistedProvider(persisted)
		if err != nil {
			t.Fatalf("NormalizePersistedProvider(%q): %v", persisted, err)
		}
		if _, err := ResolveProvider(launchable); err != nil {
			t.Fatalf("normalized provider %q (from %q) is not launchable: %v", launchable, persisted, err)
		}
	}
}
