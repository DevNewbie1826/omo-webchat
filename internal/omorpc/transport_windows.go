//go:build windows

package omorpc

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net"
	"time"

	"github.com/Microsoft/go-winio"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

func pipeAddress(path string, secret []byte) (string, error) {
	path, err := logicalEndpoint(path)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(append([]byte(cases.Lower(language.Und).String(path)), secret...))
	return fmt.Sprintf(`\\.\pipe\senpi-rpc-%x`, sum[:16]), nil
}

func dialEndpoint(ctx context.Context, path string) (net.Conn, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	// A reconnect may have only a lifecycle context. Bound secret/ancestor
	// acquisition as well as busy-pipe dialing and the raw authentication write.
	authCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	secret, err := readEndpointSecret(authCtx, path)
	if err != nil {
		return nil, err
	}
	address, err := pipeAddress(path, secret)
	if err != nil {
		return nil, err
	}
	raw, err := winio.DialPipeContext(authCtx, address)
	if err != nil {
		return nil, err
	}
	conn, err := identifyPipeServer(raw)
	if err != nil {
		return nil, errors.Join(err, raw.Close())
	}
	deadline, _ := authCtx.Deadline()
	if err := conn.SetWriteDeadline(deadline); err != nil {
		return nil, errors.Join(err, conn.Close())
	}
	canceled := make(chan error, 1)
	stop := context.AfterFunc(authCtx, func() {
		canceled <- conn.Close()
	})
	n, writeErr := conn.Write(secret)
	if !stop() {
		writeErr = errors.Join(writeErr, <-canceled)
	}
	if authCtx.Err() != nil {
		writeErr = authCtx.Err()
	}
	if writeErr == nil && n != len(secret) {
		writeErr = io.ErrShortWrite
	}
	if writeErr != nil {
		return nil, errors.Join(writeErr, conn.Close())
	}
	if err := conn.SetWriteDeadline(time.Time{}); err != nil {
		return nil, errors.Join(err, conn.Close())
	}
	return conn, nil
}
