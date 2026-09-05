//go:build windows

package omorpc

import (
	"bytes"
	"testing"
)

// Expected addresses were obtained from the pinned runtime transport function.
func TestWindowsPipePathForms(t *testing.T) {
	for _, tc := range []struct{ path, hash string }{
		{`C:\Users\Alice\rpc.sock`, "5d5bb35d1b13284d0c6cef3e49ae1951"},
		{`c:/users/alice/tmp/../rpc.sock`, "5d5bb35d1b13284d0c6cef3e49ae1951"},
		{`\\Server\Share\Profile Space\rpc.sock`, "8ac0065c358f4517a2601d4bac607dbb"},
	} {
		got, err := pipeAddress(tc.path, bytes.Repeat([]byte{123}, 32))
		if err != nil || got != `\\.\pipe\senpi-rpc-`+tc.hash {
			t.Fatalf("path %q: address=%q err=%v", tc.path, got, err)
		}
	}
	for _, path := range []string{`rpc.sock`, `C:rpc.sock`, `\\.\pipe\raw`, `\\?\C:\rpc.sock`} {
		if _, err := pipeAddress(path, make([]byte, 32)); err == nil {
			t.Fatalf("ambiguous or raw endpoint accepted: %q", path)
		}
	}
}

func TestWindowsPipeUnicodeRED(t *testing.T) {
	got, err := pipeAddress("C:\\\u039f\u03a3\\\u0130\\rpc.sock", bytes.Repeat([]byte{123}, 32))
	if err != nil {
		t.Fatal(err)
	}
	if got == `\\.\pipe\senpi-rpc-e8eece8854db3339c8bbfa85dcd53da6` {
		t.Fatal("RED not reproduced: full Unicode lowercase already matches")
	}
	t.Log("RED: Go simple lowercase differs from runtime full Unicode lowercase")
}
