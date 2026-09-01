package omorpc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// ErrDisconnected is the transport-level failure: the socket died (daemon
// restart, mid-request disconnect) or every reconnect attempt within the
// configured budget was exhausted. All pending requests fail with an error
// matching errors.Is(err, ErrDisconnected); reconnect failures wrap it.
var ErrDisconnected = errors.New("omorpc: transport disconnected")

// Config tunes the client. Zero-valued fields are replaced field-wise by
// the DefaultConfig values, so partial configs keep sane defaults.
type Config struct {
	EventBuffer          int
	ReconnectInitial     time.Duration
	ReconnectMax         time.Duration
	ReconnectMaxAttempts int
}

// DefaultConfig is the zero-argument configuration.
func DefaultConfig() Config {
	return Config{
		EventBuffer:          64,
		ReconnectInitial:     250 * time.Millisecond,
		ReconnectMax:         5 * time.Second,
		ReconnectMaxAttempts: 8,
	}
}

type pendingRequest struct {
	result chan callResult
}

type callResult struct {
	response *Response
	err      error
}

type connectionEpoch struct {
	number uint64
	conn   net.Conn
	events *eventStream
}

type connectFlight struct {
	done  chan struct{}
	epoch *connectionEpoch
	err   error
}

// eventStream keeps socket reads independent of subscriber speed. Its queue
// is unbounded for the lifetime of one connection epoch; stopping the epoch
// atomically drops undelivered events and closes the public stream.
type eventStream struct {
	out  chan *Event
	stop chan struct{}

	mu     sync.Mutex
	wake   chan struct{}
	queue  []*Event
	closed bool
}

func newEventStream(buffer int) *eventStream {
	s := &eventStream{
		out:  make(chan *Event, buffer),
		stop: make(chan struct{}),
		wake: make(chan struct{}, 1),
	}
	go s.run()
	return s
}

func (s *eventStream) enqueue(ev *Event) {
	s.mu.Lock()
	if !s.closed {
		s.queue = append(s.queue, ev)
		select {
		case s.wake <- struct{}{}:
		default:
		}
	}
	s.mu.Unlock()
}

func (s *eventStream) close() {
	s.mu.Lock()
	if !s.closed {
		s.closed = true
		close(s.stop)
	}
	s.mu.Unlock()
}

func (s *eventStream) run() {
	defer close(s.out)
	for {
		s.mu.Lock()
		if len(s.queue) > 0 {
			ev := s.queue[0]
			s.queue[0] = nil
			s.queue = s.queue[1:]
			s.mu.Unlock()
			select {
			case s.out <- ev:
			case <-s.stop:
				return
			}
			continue
		}
		closed := s.closed
		s.mu.Unlock()
		if closed {
			return
		}
		select {
		case <-s.wake:
		case <-s.stop:
			return
		}
	}
}

// Client is one multiplexed connection to the omo agent's Unix-socket RPC
// endpoint.
type Client struct {
	socketPath string
	cfg        Config

	mu         sync.Mutex
	writeMu    sync.Mutex
	closed     bool
	lifecycle  context.Context
	cancel     context.CancelFunc
	epoch      uint64
	current    *connectionEpoch
	connecting *connectFlight
	pending    map[string]pendingRequest
	info       *ProtocolInfo

	nextID atomic.Uint64
}

// Dial connects and completes get_protocol_info before returning.
func Dial(ctx context.Context, socketPath string) (*Client, error) {
	return DialWithConfig(ctx, socketPath, Config{})
}

// DialWithConfig is Dial with explicit tuning.
func DialWithConfig(ctx context.Context, socketPath string, cfg Config) (*Client, error) {
	cfg = normalizeConfig(cfg)
	lifecycle, cancel := context.WithCancel(context.Background())
	c := &Client{
		socketPath: socketPath,
		cfg:        cfg,
		pending:    make(map[string]pendingRequest),
		lifecycle:  lifecycle,
		cancel:     cancel,
	}
	ep, err := c.establish(ctx)
	if err != nil {
		_ = c.Close()
		return nil, err
	}
	if err := c.negotiate(ctx, ep); err != nil {
		c.invalidate(ep, err)
		_ = c.Close()
		return nil, err
	}
	return c, nil
}

func normalizeConfig(cfg Config) Config {
	defaults := DefaultConfig()
	if cfg.EventBuffer == 0 {
		cfg.EventBuffer = defaults.EventBuffer
	}
	if cfg.ReconnectInitial == 0 {
		cfg.ReconnectInitial = defaults.ReconnectInitial
	}
	if cfg.ReconnectMax == 0 {
		cfg.ReconnectMax = defaults.ReconnectMax
	}
	if cfg.ReconnectMaxAttempts == 0 {
		cfg.ReconnectMaxAttempts = defaults.ReconnectMaxAttempts
	}
	if cfg.EventBuffer < 0 {
		cfg.EventBuffer = 0
	}
	if cfg.ReconnectInitial < 0 {
		cfg.ReconnectInitial = defaults.ReconnectInitial
	}
	if cfg.ReconnectMax < cfg.ReconnectInitial {
		cfg.ReconnectMax = cfg.ReconnectInitial
	}
	if cfg.ReconnectMaxAttempts < 1 {
		cfg.ReconnectMaxAttempts = 1
	}
	return cfg
}

func (c *Client) establish(ctx context.Context) (*connectionEpoch, error) {
	var dialer net.Dialer
	conn, err := dialer.DialContext(ctx, "unix", c.socketPath)
	if err != nil {
		return nil, fmt.Errorf("%w: dial %s: %v", ErrDisconnected, c.socketPath, err)
	}

	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		_ = conn.Close()
		return nil, ErrDisconnected
	}
	c.epoch++
	ep := &connectionEpoch{number: c.epoch, conn: conn, events: newEventStream(c.cfg.EventBuffer)}
	c.current = ep
	c.mu.Unlock()

	go c.readLoop(ep)
	return ep, nil
}

func (c *Client) negotiate(ctx context.Context, ep *connectionEpoch) error {
	resp, err := c.callOnEpoch(ctx, ep, GetProtocolInfo{})
	if err != nil {
		return fmt.Errorf("%w: protocol handshake: %v", ErrDisconnected, err)
	}
	if !resp.Success {
		return fmt.Errorf("omorpc: protocol handshake: %w", resp.Err())
	}
	var info ProtocolInfo
	if err := json.Unmarshal(resp.Data, &info); err != nil {
		return fmt.Errorf("omorpc: decode protocol info: %w", err)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || c.current != ep {
		return ErrDisconnected
	}
	copyInfo := info
	copyInfo.Capabilities = append([]string(nil), info.Capabilities...)
	c.info = &copyInfo
	return nil
}

func (c *Client) readLoop(ep *connectionEpoch) {
	decoder := NewDecoder(ep.conn)
	for {
		in, err := decoder.Decode()
		if err != nil {
			if errors.Is(err, io.EOF) {
				c.invalidate(ep, errors.New("peer closed the socket"))
			} else {
				c.invalidate(ep, err)
			}
			return
		}
		if in.Response != nil {
			c.settleResponse(ep, in.Response)
			continue
		}
		if in.Event != nil {
			// Native extension events commonly wrap their useful payload in a
			// payload field. Preserve that payload for AsUnknownEvent while the
			// decoded routing fields remain on Event itself.
			var envelope struct {
				Payload json.RawMessage `json:"payload"`
			}
			if json.Unmarshal(in.Event.Raw, &envelope) == nil && len(envelope.Payload) > 0 {
				in.Event.Raw = append(json.RawMessage(nil), envelope.Payload...)
			}
			ep.events.enqueue(in.Event)
		}
	}
}

func (c *Client) settleResponse(ep *connectionEpoch, resp *Response) {
	c.mu.Lock()
	if c.current != ep {
		c.mu.Unlock()
		return
	}
	pending, ok := c.pending[resp.ID]
	if ok {
		delete(c.pending, resp.ID)
	}
	c.mu.Unlock()
	if ok {
		pending.result <- callResult{response: resp, err: resp.Err()}
		return
	}
	// A response whose caller has canceled is unsolicited from this point
	// onward and follows the same forward-compatible event path.
	ep.events.enqueue(&Event{Type: "response", SessionID: resp.SessionID, Raw: resp.Raw})
}

func (c *Client) invalidate(ep *connectionEpoch, cause error) {
	c.mu.Lock()
	if c.current != ep {
		c.mu.Unlock()
		return
	}
	c.current = nil
	c.info = nil
	c.epoch++
	pending := c.pending
	c.pending = make(map[string]pendingRequest)
	c.mu.Unlock()

	_ = ep.conn.Close()
	ep.events.close()
	err := fmt.Errorf("%w: epoch %d: %v", ErrDisconnected, ep.number, cause)
	for _, request := range pending {
		request.result <- callResult{err: err}
	}
}

func (c *Client) connection(ctx context.Context) (*connectionEpoch, error) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil, ErrDisconnected
	}
	if c.connecting != nil {
		flight := c.connecting
		c.mu.Unlock()
		select {
		case <-flight.done:
			return flight.epoch, flight.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if c.current != nil {
		ep := c.current
		c.mu.Unlock()
		return ep, nil
	}
	flight := &connectFlight{done: make(chan struct{})}
	c.connecting = flight
	c.mu.Unlock()

	go c.finishReconnect(flight)
	select {
	case <-flight.done:
		return flight.epoch, flight.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (c *Client) finishReconnect(flight *connectFlight) {
	flight.epoch, flight.err = c.reconnect(c.lifecycle)
	c.mu.Lock()
	if c.connecting == flight {
		c.connecting = nil
	}
	close(flight.done)
	c.mu.Unlock()
}

func (c *Client) reconnect(ctx context.Context) (*connectionEpoch, error) {
	backoff := c.cfg.ReconnectInitial
	var lastErr error
	for attempt := 0; attempt < c.cfg.ReconnectMaxAttempts; attempt++ {
		if attempt > 0 {
			timer := time.NewTimer(backoff)
			select {
			case <-timer.C:
			case <-ctx.Done():
				timer.Stop()
				return nil, ctx.Err()
			}
			backoff *= 2
			if backoff > c.cfg.ReconnectMax {
				backoff = c.cfg.ReconnectMax
			}
		}
		c.mu.Lock()
		closed := c.closed
		c.mu.Unlock()
		if closed {
			return nil, ErrDisconnected
		}
		ep, err := c.establish(ctx)
		if err == nil {
			err = c.negotiate(ctx, ep)
		}
		if err == nil {
			return ep, nil
		}
		lastErr = err
		if ep != nil {
			c.invalidate(ep, err)
		}
	}
	return nil, fmt.Errorf("%w: reconnect exhausted after %d attempts: %v", ErrDisconnected, c.cfg.ReconnectMaxAttempts, lastErr)
}

// Call sends a two-way request and waits for its correlated response.
func (c *Client) Call(ctx context.Context, cmd Command) (*Response, error) {
	ep, err := c.connection(ctx)
	if err != nil {
		return nil, err
	}
	return c.callOnEpoch(ctx, ep, cmd)
}

func (c *Client) callOnEpoch(ctx context.Context, ep *connectionEpoch, cmd Command) (*Response, error) {
	id := "omo_go_" + strconv.FormatUint(c.nextID.Add(1), 10)
	frame, err := EncodeRequest(id, cmd)
	if err != nil {
		return nil, err
	}
	result := make(chan callResult, 1)

	c.mu.Lock()
	if c.closed || c.current != ep {
		c.mu.Unlock()
		return nil, ErrDisconnected
	}
	c.pending[id] = pendingRequest{result: result}
	c.mu.Unlock()

	c.writeMu.Lock()
	_, writeErr := ep.conn.Write(frame)
	c.writeMu.Unlock()
	if writeErr != nil {
		c.invalidate(ep, writeErr)
	}

	select {
	case got := <-result:
		return got.response, got.err
	case <-ctx.Done():
		c.mu.Lock()
		if pending, ok := c.pending[id]; ok && pending.result == result {
			delete(c.pending, id)
		}
		c.mu.Unlock()
		return nil, ctx.Err()
	}
}

// Events returns the stream for the current connection epoch.
func (c *Client) Events() <-chan *Event {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.current != nil {
		return c.current.events.out
	}
	closed := make(chan *Event)
	close(closed)
	return closed
}

// ProtocolInfo returns a copy of the negotiated handshake payload.
func (c *Client) ProtocolInfo() *ProtocolInfo {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.info == nil {
		return nil
	}
	info := *c.info
	info.Capabilities = append([]string(nil), c.info.Capabilities...)
	return &info
}

// ServerVersion is the negotiated daemon version.
func (c *Client) ServerVersion() string {
	info := c.ProtocolInfo()
	if info == nil {
		return ""
	}
	return info.ServerVersion
}

// Close releases the socket, goroutines, pending calls, and event stream.
func (c *Client) Close() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	cancel := c.cancel
	ep := c.current
	c.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if ep != nil {
		c.invalidate(ep, errors.New("client closed"))
	}
	return nil
}
