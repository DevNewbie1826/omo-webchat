package chat

import (
	"errors"
)

type Provider struct {
	ID     string   `json:"id"`
	Label  string   `json:"label"`
	Binary string   `json:"binary"`
	Args   []string `json:"args"`
}

var providerRegistry = []Provider{
	{ID: "omo", Label: "omo", Binary: "omo", Args: []string{"--mode", "rpc", "--multi-session"}},
}

func Providers() []Provider {
	out := make([]Provider, len(providerRegistry))
	copy(out, providerRegistry)
	return out
}

func ResolveProvider(id string) (Provider, error) {
	for _, p := range providerRegistry {
		if p.ID == id {
			return p, nil
		}
	}
	return Provider{}, errors.New("chat: unknown provider " + id)
}

// NormalizePersistedProvider maps a persisted chat provider identity onto the
// launchable omo provider. Empty records predate the provider field and "senpi"
// is the pre-rebrand alias; both launched as omo, as does canonical "omo".
// Every other persisted identity belongs to a runtime omo cannot resume, so it
// is rejected and callers must keep the record untouched rather than silently
// mutating or dropping persisted state.
func NormalizePersistedProvider(persisted string) (string, error) {
	switch persisted {
	case "", "senpi", "omo":
		return "omo", nil
	default:
		return "", errors.New("chat: unsupported persisted provider " + persisted)
	}
}

func DefaultProviderID() string {
	if len(providerRegistry) == 0 {
		return ""
	}
	return providerRegistry[0].ID
}

type ProviderStatus struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	Binary    string `json:"binary"`
	Available bool   `json:"available"`
}
