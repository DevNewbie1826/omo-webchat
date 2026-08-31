package config

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadResolvesRootSymlink(t *testing.T) {
	target := t.TempDir()
	link := filepath.Join(t.TempDir(), "root")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("creating root symlink: %v", err)
	}
	want, err := filepath.EvalSymlinks(target)
	if err != nil {
		t.Fatalf("resolving target directory: %v", err)
	}

	cfg, err := Load(context.Background(), []string{"--password", "x", "--root", link})
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.Root != want {
		t.Fatalf("Config.Root = %q, want resolved root %q", cfg.Root, want)
	}
}

func TestLoadProviderNormalizationAndPrecedence(t *testing.T) {
	for _, key := range []string{"TH_PASSWORD", "TH_PORT", "TH_HOST", "TH_ROOT", "TH_DAEMON_CHILD", "OMO_PROVIDER", "GAJAE_PROVIDER"} {
		t.Setenv(key, "")
	}
	root := t.TempDir()
	for _, provider := range []string{"omo", "senpi"} {
		t.Run(provider, func(t *testing.T) {
			cfg, err := Load(context.Background(), []string{"--password", "x", "--root", root, "--provider", provider})
			if err != nil || cfg.Provider != "omo" {
				t.Fatalf("Load() = cfg %v, error %v; want provider omo", cfg, err)
			}
		})
	}
	t.Setenv("GAJAE_PROVIDER", "senpi")
	t.Setenv("OMO_PROVIDER", "omo")
	cfg, err := Load(context.Background(), []string{"--password", "x", "--root", root})
	if err != nil || cfg.Provider != "omo" {
		t.Fatalf("environment precedence: cfg %v, error %v; want provider omo", cfg, err)
	}
	t.Setenv("OMO_PROVIDER", "other")
	if _, err := Load(context.Background(), []string{"--password", "x", "--root", root}); err == nil || !strings.Contains(err.Error(), "unsupported provider") {
		t.Fatalf("unsupported provider error = %v", err)
	}
}

func TestLoadRejectsUnsupportedProviderWhenServing(t *testing.T) {
	for _, key := range []string{"TH_PASSWORD", "TH_PORT", "TH_HOST", "TH_ROOT", "TH_DAEMON_CHILD", "GAJAE_PROVIDER"} {
		t.Setenv(key, "")
	}
	root := t.TempDir()

	t.Run("flag", func(t *testing.T) {
		_, err := Load(context.Background(), []string{
			"--password", "x",
			"--root", root,
			"--provider", "omp",
		})
		if err == nil {
			t.Fatal("Load() error = nil, want unsupported provider error")
		}
		if !strings.Contains(err.Error(), "unsupported provider") {
			t.Fatalf("Load() error = %q, want error containing %q", err.Error(), "unsupported provider")
		}
	})

	t.Run("env", func(t *testing.T) {
		t.Setenv("GAJAE_PROVIDER", "omp")
		_, err := Load(context.Background(), []string{
			"--password", "x",
			"--root", root,
		})
		if err == nil {
			t.Fatal("Load() error = nil, want unsupported provider error")
		}
		if !strings.Contains(err.Error(), "unsupported provider") {
			t.Fatalf("Load() error = %q, want error containing %q", err.Error(), "unsupported provider")
		}
	})
}

func TestLoadHostDefaultLoopback(t *testing.T) {
	for _, key := range []string{"TH_PASSWORD", "TH_PORT", "TH_HOST", "TH_ROOT", "TH_DAEMON_CHILD", "OMO_PROVIDER", "GAJAE_PROVIDER"} {
		t.Setenv(key, "")
	}
	cfg, err := Load(context.Background(), []string{"--password", "x", "--root", t.TempDir()})
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.Host != "127.0.0.1" {
		t.Fatalf("Config.Host = %q, want loopback default 127.0.0.1", cfg.Host)
	}
}

func TestLoadHostEnvAndFlagOverride(t *testing.T) {
	for _, key := range []string{"TH_PASSWORD", "TH_PORT", "TH_HOST", "TH_ROOT", "TH_DAEMON_CHILD", "OMO_PROVIDER", "GAJAE_PROVIDER"} {
		t.Setenv(key, "")
	}
	root := t.TempDir()

	t.Run("env override", func(t *testing.T) {
		t.Setenv("TH_HOST", "0.0.0.0")
		cfg, err := Load(context.Background(), []string{"--password", "x", "--root", root})
		if err != nil {
			t.Fatalf("Load() error = %v", err)
		}
		if cfg.Host != "0.0.0.0" {
			t.Fatalf("Config.Host = %q, want TH_HOST override 0.0.0.0", cfg.Host)
		}
	})

	t.Run("flag beats env", func(t *testing.T) {
		t.Setenv("TH_HOST", "0.0.0.0")
		cfg, err := Load(context.Background(), []string{"--password", "x", "--root", root, "--host", "127.0.0.1"})
		if err != nil {
			t.Fatalf("Load() error = %v", err)
		}
		if cfg.Host != "127.0.0.1" {
			t.Fatalf("Config.Host = %q, want explicit --host to win over TH_HOST", cfg.Host)
		}
	})
}

func TestStateDirFlag(t *testing.T) {
	for _, key := range []string{"TH_PASSWORD", "TH_PORT", "TH_HOST", "TH_ROOT", "TH_DAEMON_CHILD", "OMO_PROVIDER", "GAJAE_PROVIDER", "TH_STATE_DIR"} {
		t.Setenv(key, "")
	}
	root := t.TempDir()

	t.Run("flag resolves to absolute path", func(t *testing.T) {
		dir := t.TempDir()
		want, err := filepath.Abs(dir)
		if err != nil {
			t.Fatalf("resolving want: %v", err)
		}
		cfg, err := Load(context.Background(), []string{"--password", "x", "--root", root, "--state-dir", dir})
		if err != nil {
			t.Fatalf("Load() error = %v", err)
		}
		if cfg.StateDir != want {
			t.Fatalf("Config.StateDir = %q, want %q", cfg.StateDir, want)
		}
	})

	t.Run("flag and env absent", func(t *testing.T) {
		cfg, err := Load(context.Background(), []string{"--password", "x", "--root", root})
		if err != nil {
			t.Fatalf("Load() error = %v", err)
		}
		if cfg.StateDir != "" {
			t.Fatalf("Config.StateDir = %q, want empty", cfg.StateDir)
		}
	})

	t.Run("env fallback", func(t *testing.T) {
		envDir := t.TempDir()
		want, err := filepath.Abs(envDir)
		if err != nil {
			t.Fatalf("resolving want: %v", err)
		}
		t.Setenv("TH_STATE_DIR", envDir)
		cfg, err := Load(context.Background(), []string{"--password", "x", "--root", root})
		if err != nil {
			t.Fatalf("Load() error = %v", err)
		}
		if cfg.StateDir != want {
			t.Fatalf("Config.StateDir = %q, want %q", cfg.StateDir, want)
		}
	})

	t.Run("flag beats env", func(t *testing.T) {
		envDir := t.TempDir()
		flagDir := t.TempDir()
		want, err := filepath.Abs(flagDir)
		if err != nil {
			t.Fatalf("resolving want: %v", err)
		}
		t.Setenv("TH_STATE_DIR", envDir)
		cfg, err := Load(context.Background(), []string{"--password", "x", "--root", root, "--state-dir", flagDir})
		if err != nil {
			t.Fatalf("Load() error = %v", err)
		}
		if cfg.StateDir != want {
			t.Fatalf("Config.StateDir = %q, want %q (flag must win over TH_STATE_DIR)", cfg.StateDir, want)
		}
	})
}

func TestLoad(t *testing.T) {
	for _, key := range []string{"TH_PASSWORD", "TH_PORT", "TH_HOST", "TH_ROOT", "TH_DAEMON_CHILD", "GAJAE_PROVIDER"} {
		t.Setenv(key, "")
	}

	ctx := context.Background()

	tests := []struct {
		name        string
		args        []string
		wantErr     string
		daemonChild bool
		check       func(t *testing.T, cfg *Config)
	}{
		{
			name: "stop succeeds without password",
			args: []string{"--stop"},
			check: func(t *testing.T, cfg *Config) {
				if !cfg.Stop {
					t.Errorf("Config.Stop = false, want true")
				}
				if cfg.Status {
					t.Errorf("Config.Status = true, want false")
				}
				if cfg.Daemon {
					t.Errorf("Config.Daemon = true, want false")
				}
			},
		},
		{
			name: "stop ignores unsupported provider",
			args: []string{"--stop", "--provider", "senpi"},
			check: func(t *testing.T, cfg *Config) {
				if !cfg.Stop {
					t.Errorf("Config.Stop = false, want true")
				}
			},
		},
		{
			name: "status succeeds without password",
			args: []string{"--status"},
			check: func(t *testing.T, cfg *Config) {
				if !cfg.Status {
					t.Errorf("Config.Status = false, want true")
				}
				if cfg.Stop {
					t.Errorf("Config.Stop = true, want false")
				}
			},
		},
		{
			name: "status ignores unsupported provider",
			args: []string{"--status", "--provider", "omp"},
			check: func(t *testing.T, cfg *Config) {
				if !cfg.Status {
					t.Errorf("Config.Status = false, want true")
				}
			},
		},
		{
			name:    "no args without password fails",
			args:    []string{},
			wantErr: "--password is required",
		},
		{
			name:    "daemon without password fails",
			args:    []string{"--daemon"},
			wantErr: "--password is required",
		},
		{
			name:    "daemon and stop cannot combine",
			args:    []string{"--daemon", "--stop"},
			wantErr: "cannot be combined",
		},
		{
			name:    "stop and status cannot combine",
			args:    []string{"--stop", "--status"},
			wantErr: "cannot be combined",
		},
		{
			name:        "daemon child environment with password succeeds",
			args:        []string{"--password", "x"},
			daemonChild: true,
			check: func(t *testing.T, cfg *Config) {
				if !cfg.DaemonChild {
					t.Errorf("Config.DaemonChild = false, want true")
				}
				if cfg.Password != "x" {
					t.Errorf("Config.Password = %q, want %q", cfg.Password, "x")
				}
			},
		},
		{
			name: "password and port succeed with absolute root",
			args: []string{"--password", "x", "--port", "18231"},
			check: func(t *testing.T, cfg *Config) {
				if cfg.Port != 18231 {
					t.Errorf("Config.Port = %d, want 18231", cfg.Port)
				}
				if !filepath.IsAbs(cfg.Root) {
					t.Errorf("Config.Root = %q, want absolute path", cfg.Root)
				}
				if cfg.Provider != "omo" {
					t.Errorf("Config.Provider = %q, want %q", cfg.Provider, "omo")
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("TH_DAEMON_CHILD", "")
			if tt.daemonChild {
				t.Setenv("TH_DAEMON_CHILD", "1")
			}
			cfg, err := Load(ctx, tt.args)
			if tt.wantErr != "" {
				if err == nil {
					t.Fatalf("Load() error = nil, want error containing %q", tt.wantErr)
				}
				if !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("Load() error = %q, want error containing %q", err.Error(), tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("Load() unexpected error: %v", err)
			}
			if cfg == nil {
				t.Fatal("Load() returned nil Config without error")
			}
			if tt.check != nil {
				tt.check(t, cfg)
			}
		})
	}
}
