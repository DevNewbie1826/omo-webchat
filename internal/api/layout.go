package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/DevNewbie1826/omo-webchat/internal/store"
)

const maxLayoutBytes = 1 << 20

func (s *Server) handleGetLayout(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]json.RawMessage{"layout": s.store.GetLayout()})
}

func (s *Server) handleSetLayout(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxLayoutBytes)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "layout too large")
		return
	}
	if len(raw) == 0 || !json.Valid(raw) {
		writeError(w, http.StatusBadRequest, "invalid layout")
		return
	}
	if err := s.store.SetLayout(raw); err != nil {
		if errors.Is(err, store.ErrInvalidLayout) {
			writeError(w, http.StatusBadRequest, "invalid layout")
			return
		}
		s.logger.Error("storing layout", "err", err)
		writeError(w, http.StatusInternalServerError, "internal server error")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
