//go:build windows

package omorpc

import (
	"errors"
	"io"
	"net"
	"os"

	"github.com/Microsoft/go-winio"
)

// go-winio supplies overlapped I/O and cancellation, but its timeout/closed
// sentinels predate the standard net.Conn error contract.
func pipeIOError(op string, err error) error {
	if err == nil || errors.Is(err, io.EOF) {
		return err
	}
	switch {
	case errors.Is(err, winio.ErrTimeout):
		err = os.ErrDeadlineExceeded
	case errors.Is(err, winio.ErrFileClosed):
		err = net.ErrClosed
	}
	return &net.OpError{Op: op, Net: "pipe", Err: err}
}

func (p *identifiedPipe) Read(data []byte) (int, error) {
	n, err := p.Conn.Read(data)
	return n, pipeIOError("read", err)
}

func (p *identifiedPipe) Write(data []byte) (int, error) {
	n, err := p.Conn.Write(data)
	return n, pipeIOError("write", err)
}
