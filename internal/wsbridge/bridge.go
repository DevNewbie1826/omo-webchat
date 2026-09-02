// Package wsbridge exposes the v2 browser WebSocket transport over session.Manager.
package wsbridge

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/lxzan/gws"

	"github.com/DevNewbie1826/omo-webchat/internal/cursorstore"
	"github.com/DevNewbie1826/omo-webchat/internal/session"
	"github.com/DevNewbie1826/omo-webchat/internal/wscontract"
)

const (
	ContractVersion     = 2
	defaultWriteTimeout = 10 * time.Second
)

// Config supplies the independently-owned v2 session stack.
type Config struct {
	Context       context.Context
	Manager       *session.Manager
	Store         *cursorstore.Store
	ServerVersion string
	Logger        *slog.Logger
	WriteTimeout  time.Duration
	// PrepareChat lazily mirrors v1 workspace/chat metadata into Store. The v2
	// cursor file remains independently owned and only resume pointers mutate.
	PrepareChat func(context.Context, string, string) error
}

// Handler is a gws event handler and an HTTP WebSocket endpoint.
type Handler struct {
	gws.BuiltinEventHandler
	cfg                Config
	upgrader           *gws.Upgrader
	conns              sync.Map // *gws.Conn -> *connection
	shutdownGeneration atomic.Uint64
	shuttingDown       atomic.Bool
}

// New builds a bridge endpoint. Authentication deliberately remains the API
// router's middleware responsibility.
func New(cfg Config) *Handler {
	if cfg.Context == nil {
		cfg.Context = context.Background()
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.WriteTimeout <= 0 {
		cfg.WriteTimeout = defaultWriteTimeout
	}
	h := &Handler{cfg: cfg}
	h.upgrader = gws.NewUpgrader(h, &gws.ServerOption{
		Recovery:          gws.Recovery,
		PermessageDeflate: gws.PermessageDeflate{Enabled: true},
		Authorize:         func(r *http.Request, _ gws.SessionStorage) bool { return originAllowed(r) },
	})
	if done := cfg.Context.Done(); done != nil {
		go func() {
			<-done
			h.CloseConnections()
		}()
	}
	return h
}

// CloseConnections closes every upgraded socket, including sockets that have
// not completed hello or bound a chat.
func (h *Handler) CloseConnections() {
	h.shuttingDown.Store(true)
	h.shutdownGeneration.Add(1)
	h.conns.Range(func(key, value any) bool {
		h.conns.Delete(key)
		value.(*connection).shutdown()
		return true
	})
}

// DefaultHandler is the production mount seam while the v1 Server constructor
// remains byte-compatible. A v2 bootstrap can install a configured endpoint
// without making the v1 API own v2 lifecycle dependencies.
type endpointHolder struct {
	handler http.Handler
	id      uint64
}

var (
	defaultEndpoint atomic.Value // endpointHolder
	endpointID      atomic.Uint64
)

// Unavailable returns a diagnostic endpoint for a v2 stack that could not start.
func Unavailable(reason string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"error":  "v2 websocket bridge is not configured",
			"reason": reason,
		})
	})
}

func init() { defaultEndpoint.Store(endpointHolder{handler: Unavailable("startup not completed")}) }

// InstallDefault atomically installs the endpoint used by the API mount and
// returns an ownership-safe remover for server shutdown.
func InstallDefault(h http.Handler) func() {
	if h == nil {
		return func() {}
	}
	id := endpointID.Add(1)
	defaultEndpoint.Store(endpointHolder{handler: h, id: id})
	return func() {
		current := defaultEndpoint.Load().(endpointHolder)
		if current.id == id {
			defaultEndpoint.Store(endpointHolder{handler: Unavailable("server stopped")})
		}
	}
}

// InstallUnavailable publishes a diagnostic 503 endpoint.
func InstallUnavailable(reason string) func() { return InstallDefault(Unavailable(reason)) }

// DefaultHandler returns the currently installed v2 endpoint.
func DefaultHandler() http.Handler { return defaultEndpoint.Load().(endpointHolder).handler }

func originAllowed(r *http.Request) bool {
	origins := r.Header.Values("Origin")
	if len(origins) == 0 {
		return true
	}
	if len(origins) != 1 || origins[0] == "" {
		return false
	}
	o, err := url.Parse(origins[0])
	if err != nil || o.Host == "" || o.User != nil || o.Path != "" || o.RawQuery != "" || o.ForceQuery || o.Fragment != "" {
		return false
	}
	if !strings.EqualFold(o.Scheme, "http") && !strings.EqualFold(o.Scheme, "https") {
		return false
	}
	return strings.EqualFold(o.Host, r.Host)
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h.cfg.Manager == nil || h.cfg.Store == nil {
		http.Error(w, "v2 websocket bridge is not configured", http.StatusServiceUnavailable)
		return
	}
	if !originAllowed(r) {
		http.Error(w, "websocket origin not allowed", http.StatusForbidden)
		return
	}
	if h.shuttingDown.Load() || h.cfg.Context.Err() != nil {
		http.Error(w, "v2 websocket bridge is shutting down", http.StatusServiceUnavailable)
		return
	}
	generation := h.shutdownGeneration.Load()
	sock, err := h.upgrader.Upgrade(w, r)
	if err != nil {
		h.cfg.Logger.Warn("v2 websocket upgrade failed", "error", err)
		return
	}
	ctx, cancel := context.WithCancel(h.cfg.Context)
	c := &connection{bridge: h, socket: sock, ctx: ctx, cancel: cancel, work: make(chan []byte, 64)}
	c.sub = newSubscriber(c)
	h.conns.Store(sock, c)
	if h.shuttingDown.Load() || h.cfg.Context.Err() != nil || h.shutdownGeneration.Load() != generation {
		c.shutdown()
		return
	}
	go c.run()
	if err := c.write(wscontract.HelloFrame{Type: "hello", Version: ContractVersion, ServerVersion: h.cfg.ServerVersion}); err != nil {
		c.shutdown()
		return
	}
	go sock.ReadLoop()
}

func (h *Handler) OnMessage(sock *gws.Conn, msg *gws.Message) {
	defer msg.Close()
	if raw, ok := h.conns.Load(sock); ok {
		c := raw.(*connection)
		frame := append([]byte(nil), msg.Bytes()...)
		select {
		case c.work <- frame:
		case <-c.ctx.Done():
		default:
			c.sendError("bad_frame", "too many queued client frames", "", "")
			c.shutdown()
		}
	}
}
func (h *Handler) OnClose(sock *gws.Conn, err error) {
	if raw, ok := h.conns.LoadAndDelete(sock); ok {
		raw.(*connection).shutdown()
	}
	if err != nil {
		h.cfg.Logger.Debug("v2 websocket closed", "error", err)
	}
}

type connection struct {
	bridge       *Handler
	socket       *gws.Conn
	ctx          context.Context
	cancel       context.CancelFunc
	sub          *subscriber
	writeMu      sync.Mutex
	stateMu      sync.Mutex
	wsID, chatID string
	sess         *session.Session
	detach       func()
	hello        bool
	work         chan []byte
	closed       atomic.Bool
}

func (c *connection) write(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.closed.Load() {
		return netClosedError{}
	}
	nc := c.socket.NetConn()
	if nc == nil {
		return netClosedError{}
	}
	if err = nc.SetWriteDeadline(time.Now().Add(c.bridge.cfg.WriteTimeout)); err != nil {
		return err
	}
	defer nc.SetWriteDeadline(time.Time{})
	return c.socket.WriteMessage(gws.OpcodeText, b)
}

type netClosedError struct{}

func (netClosedError) Error() string { return "websocket closed" }

func (c *connection) shutdown() {
	c.bridge.conns.Delete(c.socket)
	if !c.closed.CompareAndSwap(false, true) {
		return
	}
	c.cancel()
	c.unbind()
	if nc := c.socket.NetConn(); nc != nil {
		_ = nc.Close()
	}
}
func (c *connection) unbind() (string, *session.Session) {
	c.stateMu.Lock()
	id, s, detach := c.chatID, c.sess, c.detach
	c.wsID, c.chatID, c.sess, c.detach = "", "", nil, nil
	c.stateMu.Unlock()
	if detach != nil {
		detach()
	}
	return id, s
}
func (c *connection) binding() (string, *session.Session) {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	return c.chatID, c.sess
}

func (c *connection) run() {
	for {
		select {
		case <-c.ctx.Done():
			return
		case raw := <-c.work:
			ctx, cancel := context.WithTimeout(c.ctx, 15*time.Second)
			c.route(ctx, raw)
			cancel()
		}
	}
}

func (c *connection) route(ctx context.Context, raw []byte) {
	var probe map[string]json.RawMessage
	if json.Unmarshal(raw, &probe) != nil || probe == nil {
		c.sendError("bad_frame", "invalid json frame", "", "")
		return
	}
	var typ string
	if json.Unmarshal(probe["type"], &typ) != nil || typ == "" {
		c.sendError("bad_frame", "frame type is required", "", "")
		return
	}
	// Accept the documented browser spelling while the generated enum retains
	// the provider command spelling.
	if typ == "chat.send" {
		var send struct {
			Run struct {
				Kind string `json:"kind"`
			} `json:"run"`
		}
		if json.Unmarshal(raw, &send) == nil && send.Run.Kind == "followUp" {
			var normalized map[string]any
			if json.Unmarshal(raw, &normalized) == nil {
				if run, ok := normalized["run"].(map[string]any); ok {
					run["kind"] = "follow_up"
					raw, _ = json.Marshal(normalized)
				}
			}
		}
	}
	frame, err := wscontract.ParseClientFrame(raw)
	if err != nil {
		c.sendError("bad_frame", "invalid json frame", "", "")
		return
	}
	if _, unknown := frame.(wscontract.UnknownFrame); unknown {
		c.sendError("unknown_type", "unknown frame type: "+typ, "", "")
		return
	}
	if _, unknown := frame.(*wscontract.UnknownFrame); unknown {
		c.sendError("unknown_type", "unknown frame type: "+typ, "", "")
		return
	}

	if f, ok := frame.(*wscontract.ClientHelloFrame); ok {
		if f.Version != ContractVersion {
			c.sendError("bad_frame", "wire contract version mismatch", "", "")
			return
		}
		c.stateMu.Lock()
		c.hello = true
		c.stateMu.Unlock()
		return
	}
	c.stateMu.Lock()
	greeted := c.hello
	c.stateMu.Unlock()
	if !greeted {
		c.sendError("bad_frame", "client hello required", "", "")
		return
	}
	if _, ok := frame.(*wscontract.PingFrame); ok {
		_ = c.write(wscontract.PongFrame{Type: "pong"})
		return
	}
	if f, ok := frame.(*wscontract.ChatCreateFrame); ok {
		c.create(ctx, f)
		return
	}

	bound, sess := c.binding()
	target := clientSessionID(frame)
	if target != bound && !(typ == "activity.refresh" && bound == "") {
		c.sendError("session_mismatch", "frame sessionId does not match this socket's chat", "", requestID(frame))
		return
	}
	if sess == nil && typ != "activity.refresh" {
		c.sendError("session_mismatch", "no chat is bound to this socket", "", requestID(frame))
		return
	}

	// Session operations from different sockets share the manager's per-chat
	// flight. Disconnect already enters that flight internally via StopContext.
	if typ != "chat.disconnect" && bound != "" {
		release, lockErr := c.bridge.cfg.Manager.EnterChat(ctx, bound)
		if lockErr != nil {
			c.sendSessionError(lockErr, typ, requestID(frame))
			return
		}
		defer release()
	}

	switch f := frame.(type) {
	case *wscontract.ChatSendFrame:
		images := make([]map[string]string, len(f.Run.Images))
		for i, x := range f.Run.Images {
			images[i] = map[string]string{"data": x.Data, "mimeType": x.MimeType}
		}
		switch string(f.Run.Kind) {
		case "prompt":
			err = sess.SendPrompt(ctx, f.Run.Message, images)
		case "steer":
			err = sess.SendSteer(ctx, f.Run.Message)
		case "follow_up", "followUp":
			err = sess.SendFollowUp(ctx, f.Run.Message)
		default:
			c.sendError("bad_frame", "unknown run kind", "chat.send", "")
			return
		}
		if err != nil {
			c.sendSessionError(err, "chat.send", "")
		}
	case *wscontract.ChatAbortFrame:
		if err := sess.Abort(ctx); err != nil {
			c.sendSessionError(err, "chat.abort", "")
		}
	case *wscontract.ChatSetFrame:
		rid := deref(f.RequestID)
		if f.Model != nil {
			c.sendAck("set_model", rid)
			if err := sess.SetModel(ctx, f.Model.Provider, f.Model.ModelID, rid); err != nil {
				c.sendSessionError(err, "set_model", rid)
			}
		}
		if f.ThinkingLevel != nil {
			c.sendAck("set_thinking", rid)
			if err := sess.SetThinking(ctx, *f.ThinkingLevel, rid); err != nil {
				c.sendSessionError(err, "set_thinking", rid)
			}
		}
	case *wscontract.ApprovalRespondFrame:
		value := ""
		if f.Value != nil {
			value = *f.Value
		}
		if err := sess.RespondApprovalRequest(ctx, f.ID, deref(f.RequestID), value, f.Confirmed, f.Cancelled != nil && *f.Cancelled); err != nil {
			c.sendSessionError(err, "approval.respond", deref(f.RequestID))
		}
	case *wscontract.ChatCommandsFrame:
		c.queryCommands(ctx, sess)
	case *wscontract.ChatCompactFrame:
		if err := sess.Compact(ctx); err != nil {
			c.sendSessionError(err, "chat.compact", "")
		}
	case *wscontract.ChatModelsFrame:
		c.queryModels(ctx, sess)
	case *wscontract.ChatStatsFrame:
		c.queryStats(ctx, sess)
	case *wscontract.ActivityRefreshFrame:
		if sess != nil {
			for _, x := range sess.ActivitySnapshot() {
				_ = c.sub.DeliverFrame(x)
			}
		}
	case *wscontract.ChatResumeFrame:
		c.queryState(ctx, sess)
	case *wscontract.ChatCloseFrame:
		c.unbind()
	case *wscontract.ChatDisconnectFrame:
		id, _ := c.unbind()
		if id != "" {
			_ = c.bridge.cfg.Manager.StopContext(ctx, id)
		}
	default:
		c.sendError("unknown_type", "unknown frame type: "+typ, "", requestID(frame))
	}
}

func (c *connection) create(ctx context.Context, f *wscontract.ChatCreateFrame) {
	c.unbind()
	c.sub = newSubscriber(c)
	sub := c.sub
	if c.bridge.cfg.PrepareChat != nil {
		if err := c.bridge.cfg.PrepareChat(ctx, f.WsID, f.ChatID); err != nil {
			c.sendError("no_chat", err.Error(), "", "")
			return
		}
	}
	rec, err := c.bridge.cfg.Store.GetChat(f.ChatID)
	if err != nil {
		c.sendError("no_chat", "chat not found", "", "")
		return
	}
	if rec.WorkspaceID != f.WsID {
		c.sendError("bad_create", "chat does not belong to workspace", "", "")
		return
	}
	ref := chatRef{id: rec.ID, cwd: rec.CWD}
	sess, _, detach, err := c.bridge.cfg.Manager.AcquireInitialized(ctx, ref, sub, func(acquired *session.Session, started bool, acquiredDetach func()) {
		wrappedDetach := sub.wrapDetach(acquiredDetach)
		c.stateMu.Lock()
		if c.closed.Load() {
			c.stateMu.Unlock()
			wrappedDetach()
			return
		}
		c.wsID, c.chatID, c.sess, c.detach = f.WsID, f.ChatID, acquired, wrappedDetach
		c.stateMu.Unlock()
		if !sub.activate(ctx, !started) {
			c.unbind()
			return
		}
		if touchErr := c.bridge.cfg.Store.TouchLastUsed(f.ChatID); touchErr != nil {
			c.bridge.cfg.Logger.Warn("touching v2 chat last-used time", "chat_id", f.ChatID, "error", touchErr)
		}
		c.queryState(ctx, acquired)
		c.queryModels(ctx, acquired)
		c.queryCommands(ctx, acquired)
		c.queryStats(ctx, acquired)
		if !started {
			acquired.LoadEntries(ctx)
		}
	})
	if err != nil {
		c.sendError("start_failed", err.Error(), "", "")
		return
	}
	c.stateMu.Lock()
	stillBound := c.sess == sess
	c.stateMu.Unlock()
	if !stillBound && detach != nil {
		detach()
	}
}

func (c *connection) sendAck(command, requestID string) {
	sid, _ := c.binding()
	f := wscontract.AckFrame{Type: "ack", Command: command}
	if sid != "" {
		f.SessionID = &sid
	}
	if requestID != "" {
		f.RequestID = &requestID
	}
	_ = c.write(f)
}
func (c *connection) sendError(code, message, command, requestID string) {
	sid, _ := c.binding()
	m := map[string]any{"type": "error", "code": code, "message": message}
	if sid != "" {
		m["sessionId"] = sid
	}
	if command != "" {
		m["command"] = command
	}
	if requestID != "" {
		m["requestId"] = requestID
	}
	_ = c.write(m)
}
func (c *connection) sendSessionError(err error, command, requestID string) {
	code := "provider_error"
	if errors.Is(err, session.ErrPromptInFlight) {
		code = "prompt_in_flight"
	}
	if errors.Is(err, session.ErrCompactionInFlight) {
		code = "compaction_in_flight"
	}
	c.sendError(code, err.Error(), command, requestID)
}

func (c *connection) queryState(ctx context.Context, s *session.Session) {
	x, err := s.QueryState(ctx)
	if err != nil {
		c.sendSessionError(err, "get_state", "")
		return
	}
	var model map[string]any
	if len(x.Model) > 0 {
		_ = json.Unmarshal(x.Model, &model)
		if id, ok := model["id"].(string); ok {
			model["modelId"] = id
			delete(model, "id")
		}
	}
	run := s.RunSnapshot()
	sid, _ := c.binding()
	_ = c.write(map[string]any{"type": "state", "sessionId": sid, "model": model, "thinkingLevel": x.ThinkingLevel, "isStreaming": run.Streaming, "isCompacting": run.Compacting})
}
func (c *connection) queryModels(ctx context.Context, s *session.Session) {
	xs, err := s.Models(ctx)
	if err != nil {
		c.sendSessionError(err, "get_available_models", "")
		return
	}
	sid, _ := c.binding()
	out := make([]wscontract.ModelInfo, len(xs))
	for i, x := range xs {
		out[i] = wscontract.ModelInfo{Provider: x.Provider, ModelID: x.ModelID}
		if x.Name != "" {
			out[i].Name = &x.Name
		}
	}
	_ = c.write(wscontract.ModelsFrame{Type: "models", SessionID: sid, Models: out})
}
func (c *connection) queryCommands(ctx context.Context, s *session.Session) {
	xs, err := s.Commands(ctx)
	if err != nil {
		c.sendSessionError(err, "get_commands", "")
		return
	}
	sid, _ := c.binding()
	out := make([]wscontract.CommandEntry, len(xs))
	for i, x := range xs {
		out[i] = commandEntry(x)
	}
	_ = c.write(wscontract.CommandsFrame{Type: "commands", SessionID: sid, Commands: out})
}
func (c *connection) queryStats(ctx context.Context, s *session.Session) {
	x, err := s.Stats(ctx)
	if err != nil {
		c.sendSessionError(err, "get_session_stats", "")
		return
	}
	sid, _ := c.binding()
	frame := map[string]any{"type": "stats", "sessionId": sid, "cost": x.Cost}
	if len(x.Tokens) != 0 {
		frame["tokens"] = x.Tokens
	}
	if len(x.ContextUsage) != 0 {
		frame["contextUsage"] = contextUsageWithPercent(x.ContextUsage)
	}
	_ = c.write(frame)
}

func contextUsageWithPercent(raw json.RawMessage) json.RawMessage {
	var usage map[string]any
	if json.Unmarshal(raw, &usage) != nil || usage["percent"] != nil {
		return raw
	}
	used, usedOK := usage["used"].(float64)
	total, totalOK := usage["total"].(float64)
	if !usedOK || !totalOK {
		used, usedOK = usage["tokens"].(float64)
		total, totalOK = usage["contextWindow"].(float64)
	}
	percent := 0.0
	if usedOK && totalOK && total > 0 {
		percent = used / total * 100
	}
	usage["percent"] = percent
	normalized, err := json.Marshal(usage)
	if err != nil {
		return raw
	}
	return normalized
}

func commandEntry(x session.CommandInfo) wscontract.CommandEntry {
	out := wscontract.CommandEntry{Name: x.Name}
	if x.Description != "" {
		out.Description = &x.Description
	}
	if x.Source != "" {
		out.Source = &x.Source
	}
	if x.Syntax != "" {
		out.Syntax = &x.Syntax
	}
	if x.SourceInfo != nil {
		si := x.SourceInfo
		out.SourceInfo = &wscontract.CommandSourceInfo{}
		if si.Path != "" {
			out.SourceInfo.Path = &si.Path
		}
		if si.BaseDir != "" {
			out.SourceInfo.BaseDir = &si.BaseDir
		}
		if si.Source != "" {
			out.SourceInfo.Source = &si.Source
		}
		if si.Scope != "" {
			out.SourceInfo.Scope = &si.Scope
		}
		if si.Origin != "" {
			out.SourceInfo.Origin = &si.Origin
		}
	}
	return out
}
func deref(x *string) string {
	if x == nil {
		return ""
	}
	return *x
}
func clientSessionID(f wscontract.ClientFrame) string {
	switch x := f.(type) {
	case *wscontract.ChatSendFrame:
		return x.SessionID
	case *wscontract.ChatAbortFrame:
		return x.SessionID
	case *wscontract.ChatSetFrame:
		return x.SessionID
	case *wscontract.ApprovalRespondFrame:
		return x.SessionID
	case *wscontract.ChatCommandsFrame:
		return x.SessionID
	case *wscontract.ChatCompactFrame:
		return x.SessionID
	case *wscontract.ChatModelsFrame:
		return x.SessionID
	case *wscontract.ChatStatsFrame:
		return x.SessionID
	case *wscontract.ActivityRefreshFrame:
		return x.SessionID
	case *wscontract.ChatResumeFrame:
		return x.SessionID
	case *wscontract.ChatCloseFrame:
		return x.SessionID
	case *wscontract.ChatDisconnectFrame:
		return x.SessionID
	}
	return ""
}
func requestID(f wscontract.ClientFrame) string {
	switch x := f.(type) {
	case *wscontract.ChatSetFrame:
		return deref(x.RequestID)
	case *wscontract.ApprovalRespondFrame:
		return deref(x.RequestID)
	}
	return ""
}

type chatRef struct{ id, cwd string }

func (c chatRef) ChatID() string { return c.id }
func (c chatRef) CWD() string    { return c.cwd }

// CursorStore adapts cursorstore's atomic chat records to session persistence.
type CursorStore cursorstore.Store

func (s *CursorStore) CursorFor(_ context.Context, id string) (session.Cursor, error) {
	c, err := (*cursorstore.Store)(s).GetChat(id)
	if err != nil {
		return session.Cursor{}, err
	}
	return session.Cursor{SessionFile: c.SessionFile, DurableSessionID: c.DurableSessionID}, nil
}
func (s *CursorStore) SaveCursor(_ context.Context, id string, cur session.Cursor) error {
	st := (*cursorstore.Store)(s)
	c, err := st.GetChat(id)
	if err != nil {
		return err
	}
	c.SessionFile, c.DurableSessionID = cur.SessionFile, cur.DurableSessionID
	return st.SaveChat(c)
}

var _ session.CursorStore = (*CursorStore)(nil)
var _ http.Handler = (*Handler)(nil)
