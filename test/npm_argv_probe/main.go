package main

import (
	"encoding/json"
	"os"
	"runtime"
)

func main() {
	result := struct {
		Args  []string `json:"args"`
		Agent string   `json:"agent"`
		OS    string   `json:"os"`
		Arch  string   `json:"arch"`
	}{os.Args[1:], os.Getenv("CHAT_PI_BINARY"), runtime.GOOS, runtime.GOARCH}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		os.Exit(2)
	}
	if len(os.Args) > 1 && os.Args[1] == "--exit-seven" {
		os.Exit(7)
	}
}
