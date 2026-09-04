BINARY := omo-webchat
PKG := ./cmd/server

.PHONY: default build frontend clean run

default: build

frontend:
	cd frontend && npm ci --no-audit --no-fund && npm run build

build: frontend
	go build -trimpath -ldflags="-s -w" -o bin/$(BINARY) $(PKG)

run: build
	./bin/$(BINARY) --password dev123

clean:
	rm -rf bin frontend/dist/assets frontend/dist/index.html
