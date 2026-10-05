package api

import (
	"context"

	"github.com/DevNewbie1826/omo-webchat/internal/rpcwatch"
)

// startRPCWatcher uses the same RPC client as the manager. Stop joins the poll
// before that shared client is closed; a nil caller leaves an empty snapshot.
func (s *Server) startRPCWatcher(caller rpcwatch.Caller) func() {
	s.rpcWatcher = rpcwatch.New(caller)
	if caller == nil {
		return func() {}
	}
	ctx, cancel := context.WithCancel(s.ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.rpcWatcher.Run(ctx)
	}()
	return func() {
		cancel()
		<-done
	}
}
