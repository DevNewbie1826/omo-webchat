package session

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/DevNewbie1826/omo-webchat/internal/omorpc"
)

// GetMedia fetches one inline media block by its image_ref placeholder ref:
// the placeholder's ref (toolCallId plus contentIndex) addresses the block
// inside the engine session, and the reply carries the original image
// content. The call is read-only, so it follows the query-command plumbing
// (no write preparation, no send-operation ledger). Coordinates that do not
// resolve to a media block fail with a *omorpc.StableError whose code is
// omorpc.ErrCodeMediaNotFound.
func (s *Session) GetMedia(ctx context.Context, toolCallID string, contentIndex int) (*omorpc.GetMediaData, error) {
	s.lifecycleMu.Lock()
	route, err := s.routeLocked()
	s.lifecycleMu.Unlock()
	if err != nil {
		return nil, err
	}
	resp, err := s.client.Call(ctx, omorpc.GetMedia{SessionID: route, ToolCallID: toolCallID, ContentIndex: contentIndex})
	if err != nil {
		return nil, s.classifyRouteError(err)
	}
	var data omorpc.GetMediaData
	if err := json.Unmarshal(resp.Data, &data); err != nil {
		return nil, fmt.Errorf("session: decode get_media data: %w", err)
	}
	return &data, nil
}
