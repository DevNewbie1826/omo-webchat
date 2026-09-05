//go:build windows

package transport

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/Microsoft/go-winio"
)

func address(path string, secret []byte) string {
	sum := sha256.Sum256(append([]byte(strings.ToLower(filepath.Clean(path))), secret...))
	return fmt.Sprintf(`\\.\pipe\senpi-rpc-%x`, sum[:16])
}

// Every listener lifetime has fresh auth, so reconnect tests also exercise a
// changed secret instead of accidentally reusing cached credentials.
func Listen(path string) (net.Listener, error) {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path+".secret", secret, 0600); err != nil {
		return nil, err
	}
	ln, err := winio.ListenPipe(address(path, secret), nil)
	if err != nil {
		return nil, err
	}
	return &listener{Listener: ln, secret: secret}, nil
}

func Dial(ctx context.Context, path string) (net.Conn, error) {
	secret, err := os.ReadFile(path + ".secret")
	if err != nil {
		return nil, err
	}
	conn, err := winio.DialPipeContext(ctx, address(path, secret))
	if err != nil {
		return nil, err
	}
	if _, err := conn.Write(secret); err != nil {
		return nil, errors.Join(err, conn.Close())
	}
	return conn, nil
}

type listener struct {
	net.Listener
	secret []byte
}

func (l *listener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return &authenticatedConn{Conn: c, secret: l.secret}, nil
}

type authenticatedConn struct {
	net.Conn
	secret  []byte
	once    sync.Once
	authErr error
}

func (c *authenticatedConn) Read(p []byte) (int, error) {
	c.once.Do(func() {
		got := make([]byte, 32)
		_, c.authErr = io.ReadFull(c.Conn, got)
		if c.authErr == nil && !bytes.Equal(got, c.secret) {
			c.authErr = errors.New("fixture: invalid pipe handshake")
		}
	})
	if c.authErr != nil {
		return 0, c.authErr
	}
	return c.Conn.Read(p)
}
