package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"sync"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc/omorpctest"
)

// fakeRPC delegates the observed protocol to the shared daemon. Only canonical
// history reads are controlled here; no chat.todo frame is authored by QA.
type fakeRPC struct {
	daemon   *omorpctest.Daemon
	journal  *journal
	listener net.Listener
	mu       sync.Mutex
	conns    map[net.Conn]struct{}
	closed   bool
	wg       sync.WaitGroup
	reads    int
}

func startProvider(path string, d *omorpctest.Daemon, j *journal) (*fakeRPC, error) {
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	p := &fakeRPC{daemon: d, journal: j, listener: ln, conns: make(map[net.Conn]struct{})}
	p.wg.Add(1)
	go func() {
		defer p.wg.Done()
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			p.mu.Lock()
			if p.closed {
				p.mu.Unlock()
				c.Close()
				return
			}
			p.conns[c] = struct{}{}
			p.wg.Add(1)
			p.mu.Unlock()
			go p.serve(c)
		}
	}()
	return p, nil
}
func (p *fakeRPC) serve(client net.Conn) {
	defer p.wg.Done()
	defer func() { client.Close(); p.mu.Lock(); delete(p.conns, client); p.mu.Unlock() }()
	upstream, err := net.Dial("unix", p.daemon.SocketPath())
	if err != nil {
		slog.Error("fixture upstream dial", "error", err)
		return
	}
	defer upstream.Close()
	p.mu.Lock()
	p.conns[upstream] = struct{}{}
	p.mu.Unlock()
	defer func() { p.mu.Lock(); delete(p.conns, upstream); p.mu.Unlock() }()
	var writeMu sync.Mutex
	send := func(raw []byte) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		_, err := client.Write(append(raw, '\n'))
		return err
	}
	var calls sync.WaitGroup
	defer calls.Wait()
	calls.Add(1)
	go func() {
		defer calls.Done()
		defer client.Close()
		reader := bufio.NewReader(upstream)
		for {
			line, err := reader.ReadBytes('\n')
			if err != nil {
				return
			}
			if err := send(line[:len(line)-1]); err != nil {
				return
			}
		}
	}()
	defer upstream.Close() // close before calls.Wait, including response copier
	reader := bufio.NewReader(client)
	for {
		raw, err := reader.ReadBytes('\n')
		if err != nil {
			if !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) {
				slog.Debug("fixture client ended", "error", err)
			}
			return
		}
		var req map[string]any
		if err := json.Unmarshal(raw, &req); err != nil {
			slog.Error("fixture invalid request", "error", err)
			return
		}
		if req["type"] != "get_entries" {
			if _, err := upstream.Write(raw); err != nil {
				return
			}
			continue
		}
		// Preserve provider routing errors after idle eviction rather than letting
		// this history seam pretend an unloaded handle remains usable.
		live := false
		for _, s := range p.daemon.SessionSnapshots() {
			if s.RoutingID == req["sessionId"] && s.Live {
				live = true
			}
		}
		if !live {
			if _, err := upstream.Write(raw); err != nil {
				return
			}
			continue
		}
		p.mu.Lock()
		p.reads++
		p.mu.Unlock()
		response, gate := p.journal.response(req)
		calls.Add(1)
		go func() {
			defer calls.Done()
			if gate != nil {
				defer close(gate.completed)
				<-gate.release
			}
			raw, err := json.Marshal(response)
			if err != nil {
				slog.Error("fixture encode response", "error", err)
				return
			}
			if err := send(raw); err != nil && !errors.Is(err, net.ErrClosed) {
				slog.Debug("fixture response ended", "error", err)
			}
		}()
	}
}
func (p *fakeRPC) close() error {
	p.mu.Lock()
	p.closed = true
	err := p.listener.Close()
	for c := range p.conns {
		c.Close()
	}
	p.mu.Unlock()
	p.journal.releaseAll()
	p.wg.Wait()
	return err
}
