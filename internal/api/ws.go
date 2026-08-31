package api

import (
	"context"
	"net/http"
	"net/url"
	"strings"

	"github.com/lxzan/gws"
)

func wsOriginAllowed(r *http.Request) bool {
	origins := r.Header.Values("Origin")
	if len(origins) == 0 {
		return true
	}
	if len(origins) != 1 || origins[0] == "" {
		return false
	}

	origin, err := url.Parse(origins[0])
	if err != nil || origin.Host == "" || origin.User != nil || origin.Path != "" || origin.RawQuery != "" || origin.ForceQuery || origin.Fragment != "" {
		return false
	}
	if !strings.EqualFold(origin.Scheme, "http") && !strings.EqualFold(origin.Scheme, "https") {
		return false
	}
	return strings.EqualFold(origin.Host, r.Host)
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	if !wsOriginAllowed(r) {
		writeError(w, http.StatusForbidden, "websocket origin not allowed")
		return
	}
	socket, err := s.upgrader.Upgrade(w, r)
	if err != nil {
		s.logger.Warn("websocket upgrade failed", "err", err)
		return
	}
	connCtx, cancel := context.WithCancel(s.ctx)
	h := &connHandler{srv: s, conn: socket, ctx: connCtx, cancel: cancel}
	s.conns.Store(socket, h)
	go socket.ReadLoop()
}

func (s *Server) OnMessage(socket *gws.Conn, message *gws.Message) {
	defer func() { _ = message.Close() }()
	val, ok := s.conns.Load(socket)
	if !ok {
		return
	}
	h := val.(*connHandler)
	s.routeMessage(h, append([]byte(nil), message.Bytes()...))
}

func (s *Server) OnClose(socket *gws.Conn, err error) {
	if err != nil {
		s.logger.Debug("websocket closed", "err", err)
	}
	if val, ok := s.conns.LoadAndDelete(socket); ok {
		h := val.(*connHandler)
		// Cancel before detaching so an open_session still waiting on provider
		// I/O is released by this connection's lifetime, not the server's.
		h.cancelConnection()
		_, detach := h.detachSession()
		if detach != nil {
			detach()
		}
	}
}
