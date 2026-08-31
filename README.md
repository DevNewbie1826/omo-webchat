# omo-webchat

로컬에서 omo CLI와 대화하는 웹 UI입니다. `omo-webchat` 한 개의 Go 바이너리가 임베드된 React SPA를 서빙하고, 실행하는 에이전트는 `PATH`의 `omo --mode rpc --multi-session` 한 프로세스뿐입니다.

A local web UI for omo. One Go binary serves an embedded React SPA and launches a single `omo --mode rpc --multi-session` process.

저장소: [github.com/DevNewbie1826/omo-webchat](https://github.com/DevNewbie1826/omo-webchat)

---

## 한국어

### 무엇이 돌아가는가

서버는 비밀번호를 받은 뒤 브라우저 SPA를 열고, 워크스페이스마다 채팅을 만듭니다. 채팅은 서버가 소유한 공유 omo 자식 프로세스(`omo --mode rpc --multi-session`) 위에 `open_session`으로 열리는 논리 세션이고, 클라이언트와는 WebSocket으로 연결됩니다. HTTP 서버는 omo 없이 기동되지만, `omo`가 `PATH`에 없으면 채팅 생성이 거절됩니다 (`503`, `provider CLI is unavailable`).

실행 가능한 프로바이더는 omo 하나뿐입니다. 프론트는 생성을 `"omo"`로만 요청합니다. 디스크에 남은 빈 값·`senpi` 레코드는 목록에서 omo로 보이고, 그 외 프로바이더는 파일에 그대로 두되 목록에서는 숨깁니다.

### 기능

- 로그인 페이지 뒤의 SPA. `/api/*`는 세션 쿠키가 필요하고, 정적 UI(`/`)는 인증하지 않습니다.
- 워크스페이스: `--root` 아래 디렉터리를 고르고, 그 아래 채팅을 묶습니다.
- 새 채팅: `/api/providers`가 이미 omo를 사용 가능으로 보고하면 모달 없이 바로 생성합니다. 모달은 조회 중·실패·미설치 복구용입니다. 서버는 바이너리가 없으면 생성을 거절합니다.
- WebSocket 실시간 대화, 스트리밍, GFM 마크다운.
- `/` 슬래시 명령, `$` → `skill:<name>` 스킬 팔레트. 방향키·Enter/Tab으로 넣고 Escape로 닫으며, 선택만으로는 전송하지 않습니다.
- `@`로 워크스페이스 파일 멘션 (`--root` 경계).
- 모델 목록은 세션이 붙은 뒤 omo가 보고합니다. 생성 요청에는 모델을 넣지 않습니다.
- 컴포저 첨부는 **이미지만** (`image/*`). 모델이 이미지 입력을 지원하지 않으면 막힙니다.
- 파일 브라우저에서 임의 파일을 업로드·드래그 앤 드롭하면 **워크스페이스 디렉터리**에 씁니다. 탐색·읽기·쓰기·다운로드·검색과 워크스페이스 생성 경로는 `--root`로 제한됩니다.
- 에이전트 승인 요청을 UI 모달에서 처리합니다.
- 가로(`h`) / 세로(`v`) 분할. 뷰포트가 `1024px` 미만이면 분할 UI는 꺼집니다. 레이아웃은 서버 `state.json`에 저장됩니다.
- 폰트: System, JetBrains Mono, Fira Code, IBM Plex Mono, Source Code Pro, 나눔고딕코딩 (Google Fonts).
- 언어: 한국어 / English. 언어·폰트·글자 크기는 브라우저 `localStorage`입니다.
- 모바일: 20초 ping / 10초 pong 타임아웃, 탭이 다시 보이면 재연결, `768px` 이하 사이드바 드로어.
- 살아있는 세션 표시는 메모리의 논리 세션(공유 omo 프로세스의 라우팅 핸들) 목록입니다 (`GET /api/sessions/live`, 4초 폴링). 서버를 재시작하면 클라이언트가 다시 붙기 전까지 비어 있습니다.

### 요구 사항

**실행 (릴리스 바이너리)**

- `PATH`에 `omo`가 있어야 채팅을 만들 수 있습니다. 서버가 실행하는 명령은 `omo --mode rpc --multi-session`이며, 모든 채팅이 이 프로세스 하나를 공유합니다.
- 앱은 tmux를 쓰지 않습니다.
- 설치·릴리스 대상: macOS·Linux × amd64·arm64. Windows 릴리스는 없습니다.
- `--daemon` / `--status` / `--stop`은 darwin·linux만 지원합니다.
- 쿠키와 WebSocket을 쓰는 일반 브라우저면 됩니다.

**소스 빌드**

- Go **1.26** (`go.mod`, 릴리스 CI).
- 프론트엔드 빌드·릴리스 CI는 Node **22**. `frontend/package.json`에 `engines` 핀은 없습니다. 프론트 테스트를 돌릴 때는 lockfile의 Vitest/jsdom이 받는 Node면 됩니다.
- `make frontend`는 `npm ci`와 `npm run build`(`tsc --noEmit && vite build`)를 씁니다.

### 설치 (GitHub Releases)

```sh
curl -fsSL https://raw.githubusercontent.com/DevNewbie1826/omo-webchat/main/install.sh | sh
```

스크립트는 `curl`과 `tar`가 필요하고, `omo-webchat_<os>_<arch>.tar.gz`와 `checksums.txt`를 받은 뒤 SHA-256을 검증합니다 (`shasum -a 256` 또는 `sha256sum`). 아카이브의 `omo-webchat`을 모드 `0755`로 `INSTALL_DIR`에 넣습니다. 디렉터리와 부모가 모두 쓰기 불가일 때만 `sudo`를 씁니다.

| 환경 변수 | 기본값 | 역할 |
|---|---|---|
| `VERSION` | GitHub `releases/latest`의 `tag_name` | 특정 태그. 태그를 못 구하면 `VERSION=vX.Y.Z`를 요구하며 실패합니다. |
| `INSTALL_DIR` | `/usr/local/bin` | 설치 경로. `PATH`에 없으면 경고합니다. |

특정 태그와 홈 디렉터리 설치 예:

```sh
curl -fsSL https://raw.githubusercontent.com/DevNewbie1826/omo-webchat/main/install.sh | VERSION=vX.Y.Z INSTALL_DIR=~/.local/bin sh
```

같은 명령을 다시 실행하면 그 경로의 바이너리를 덮어씁니다. 별도 업그레이드 경로와 Windows 설치 대상은 없습니다.

`cli-webchat`에서 업그레이드할 때는 먼저 예전 데몬을 멈추십시오 (`cli-webchat --stop`). 기존 상태는 첫 실행 때 `~/.local/state/cli-webchat`에서 새 위치로 자동 복사되고, 원본은 그대로 남습니다.

설치 스크립트가 tmux 미설치 경고를 출력할 수 있습니다. **앱은 tmux를 사용하지 않으니 무시해도 됩니다.**

### 소스 빌드

```sh
make build
```

펼치면 다음입니다.

```sh
cd frontend && npm ci && npm run build
go build -trimpath -ldflags="-s -w" -o bin/omo-webchat ./cmd/server
```

산출물은 `bin/omo-webchat`입니다. SPA는 컴파일 때 `frontend/dist`를 임베드하므로, 프론트 빌드 없이 `go build ./cmd/server`만 하면 그때의 `dist`가 들어가거나 embed가 실패합니다. `make build`를 쓰십시오.

로컬에서만:

```sh
make run
```

`make build` 후 `./bin/omo-webchat --password dev123`입니다. **`dev123`은 Makefile 편의 비밀번호이지 릴리스 바이너리 기본값이 아닙니다.**

```sh
make clean
```

`bin/`과 `frontend/dist/assets`, `frontend/dist/index.html`만 지웁니다. embed가 필요로 하는 `frontend/dist` 트리 자체는 남깁니다.

릴리스 바이너리는 추가로 `CGO_ENABLED=0`입니다. 로컬 `make build`는 CGO를 강제하지 않습니다.

### 빠른 시작

```sh
omo-webchat --password <secret>
```

소스 트리에서는 `./bin/omo-webchat --password <secret>`입니다. 기본값이면 브라우저에서 `http://127.0.0.1:8080/` (또는 `http://localhost:8080`)을 열고 로그인 페이지에 비밀번호를 넣습니다. `--host` / `--port`를 바꾸면 URL도 바뀝니다.

### 플래그, 환경 변수, 우선순위

플래그가 붙은 설정은 **항상 CLI 플래그가 이깁니다.** 환경 변수는 플래그 파서의 기본값으로만 들어갑니다. 빈 문자열 환경 변수는 미설정과 같습니다. `TH_PORT`는 정수로 파싱될 때만 쓰이고, 그 외는 `8080`입니다.

| 플래그 | 환경 변수 (플래그 기본값) | 하드코딩 폴백 | 필수 | 역할 |
|---|---|---|---|---|
| `--host` | `TH_HOST` | `127.0.0.1` | 아니오 | 리슨 주소 |
| `--port` | `TH_PORT` | `8080` | 아니오 | 리슨 포트 |
| `--password` | `TH_PASSWORD` | `""` | **포그라운드·`--daemon` 서빙 시 예** | 접속 비밀번호 |
| `--root` | `TH_ROOT` | 홈 디렉터리 | 서빙 시 존재하는 디렉터리 | 파일 브라우저·워크스페이스 생성 루트. `Abs`+심볼릭 링크 해석 |
| `--state-dir` | `TH_STATE_DIR` | 없음 (아래 기본 경로) | 아니오 | 상태 디렉터리. `Abs`+`Clean`만, 심볼릭 링크는 풀지 않음. 아직 없어도 됩니다 |
| `--provider` | 아래 전용 규칙 | `omo` | 아니오 | 서빙 시 `omo`만 |
| `--daemon` | — | `false` | 아니오 | 백그라운드 자식 실행 |
| `--stop` | — | `false` | 아니오 | 데몬 중지. **비밀번호 불필요** |
| `--status` | — | `false` | 아니오 | 데몬 조회. **비밀번호 불필요** |

`--provider`만 환경 변수가 두 단입니다.

```
--provider
  > OMO_PROVIDER          (비어 있지 않을 때)
    > GAJAE_PROVIDER      (비어 있지 않을 때, 예전 이름)
      > omo
```

서빙할 때만 `senpi`를 `omo`로 바꾼 뒤, 결과가 `omo`가 아니면 `unsupported provider`로 기동을 거부합니다. `--stop` / `--status`는 프로바이더와 `--root` 존재 여부를 검사하지 않습니다.

서로 같이 쓸 수 없습니다: `--daemon`+`--stop`, `--daemon`+`--status`, `--stop`+`--status`.

플래그 대신 환경 변수만 쓸 때 (둘 다 있으면 플래그 승):

```sh
TH_PASSWORD=<secret> TH_PORT=8080 TH_HOST=127.0.0.1 TH_ROOT=~/projects TH_STATE_DIR=/path/to/state omo-webchat
```

플래그가 아닌 환경 변수:

| 변수 | 역할 |
|---|---|
| `XDG_STATE_HOME` | **절대 경로일 때만** 기본 상태 디렉터리는 `$XDG_STATE_HOME/omo-webchat`. 상대 값은 무시합니다. `--state-dir` / `TH_STATE_DIR`이 있으면 보지 않습니다. |
| 홈 디렉터리 | 기본 `--root`, 기본 상태 `$HOME/.local/state/omo-webchat`, 이전 상태 `$XDG_STATE_HOME/cli-webchat` 또는 `$HOME/.local/state/cli-webchat`, 레거시 `$HOME/.terminal-hub/state.json` |

### 보안

- 기본 바인드는 `127.0.0.1`입니다. 같은 머신만 붙습니다.
- 프로세스 안에 TLS가 없습니다. `http.Server` + `net.Listen("tcp")`입니다.
- 세션 쿠키 `th_session`은 `Path=/`, `MaxAge=86400`(24시간), `HttpOnly`, `SameSite=Strict`입니다. **어떤 바인드 주소에서도 `Secure`를 붙이지 않습니다.**
- 로그인 `POST /api/login`은 공개입니다. 비밀번호는 SHA-256 후 상수 시간 비교입니다.
- 같은 IP에서 실패 10회면 1시간 차단하고, 차단 중 재시도는 `429` `too many failed attempts, try again later`입니다. 클라이언트 IP는 `RemoteAddr`만 씁니다. `X-Forwarded-For`는 신뢰하지 않습니다.
- 토큰은 32바이트 난수의 hex이고, 검증될 때마다 24시간 TTL이 다시 시작합니다. 세션 맵은 메모리뿐이라 **프로세스가 끝나면 다시 로그인**해야 합니다.
- JSON 본문 1 MiB, 에디터 쓰기 2 MiB, 업로드 100 MiB. `ReadHeaderTimeout` 10초.
- WebSocket은 `Origin`이 있으면 단일 `http`/`https`이고 host가 `Request.Host`와 같아야 합니다. `Origin`이 없으면 허용합니다.
- 비루프백에 바인드하려면 `--host` / `TH_HOST`를 직접 바꿉니다. 그때는 TLS 종료 역프록시 뒤에 두고 평문 HTTP를 네트워크에 열지 마십시오. 이 조언은 코드가 강제하지 않습니다.

### 데몬과 상태 경로

darwin / linux:

```sh
omo-webchat --password <secret> --daemon
omo-webchat --status
omo-webchat --stop
```

`--daemon`도 비밀번호가 필요합니다. 부모는 자식이 리슨에 성공했는지 최대 3초 기다린 뒤 `omo-webchat started (pid N, http://host:port)`를 출력하고 종료합니다. `--stop`은 `SIGTERM` 후 최대 5초, 남아 있으면 `SIGKILL` 후 2초입니다. `state.json`과 로그는 지우지 않습니다.

부팅 자동 시작 유닛은 없습니다. 데몬은 `--daemon`을 실행할 때만 뜹니다.

상태 디렉터리:

```
--state-dir 또는 TH_STATE_DIR 가 있으면
    abs(clean(값))          # XDG·레거시 이주 없음
없으면
    XDG_STATE_HOME 이 절대 경로이면  $XDG_STATE_HOME/omo-webchat
    아니면                         $HOME/.local/state/omo-webchat
```

| 파일 | 모드 | 역할 |
|---|---|---|
| `state.json` | `0600` (`.tmp`에 쓰고 rename) | 워크스페이스, 채팅, 분할 레이아웃 |
| `omo-webchat.pid` | `0600` | 데몬 PID |
| `omo-webchat.log` | `0600` append | 데몬 stdout/stderr |
| `omo-webchat.lock` | `0600` + flock | 데몬 하나 |

디렉터리는 `0700`입니다.

기본 경로로 기동할 때 새 `state.json`이 아직 없으면, 두 이전 위치를 순서대로 보고 첫 번째로 존재하는 소스를 바이트 그대로 한 번 복사합니다: (1) `XDG_STATE_HOME`이 절대 경로일 때 `$XDG_STATE_HOME/cli-webchat/state.json`, 아니면 `$HOME/.local/state/cli-webchat/state.json`; (2) `$HOME/.terminal-hub/state.json`. 모든 원본은 무변경입니다. 수정·이름 변경·삭제하지 않습니다. 새 파일이 이미 있으면 이주는 하지 않습니다. `--state-dir` / `TH_STATE_DIR`에서는 이주가 없습니다.

서버를 끄면 omo 프로세스 그룹도 같이 종료됩니다. 다시 붙으면 새 공유 omo 프로세스를 띄우고, `state.json`의 `piSessionId`를 `sessionPath`로 담아 `open_session`을 본냅니다. 그 재개가 실패하면 저장된 경로를 버리고 채팅의 `cwd`로 새 논리 세션을 엽니다. 예전 OS 프로세스가 살아 있는 재개가 아닙니다. 모든 채팅이 프로세스 하나를 공유하므로, omo 프로세스가 죽으면 그 위의 활성 논리 세션 전부가 함께 끊깁니다.

브라우저만 저장하는 값: `th-lang` (`en` / `ko`), `th-font`, `th-font-size` (10–24, 기본 13).

### 아키텍처

```
cmd/server/            플래그 → 데몬 동사 또는 api.Run
internal/config/       플래그·환경 변수
internal/daemon/       unix 데몬·락. 다른 OS는 stub
internal/auth/         메모리 세션, 실패 차단, 쿠키
internal/store/        state.json 로드·저장·이주
internal/chat/         공유 multi-session omo 프로세스, open/close_session, 핸들 라우팅
internal/api/          HTTP, WebSocket, 파일시스템, 워크스페이스
frontend/              React 18 + Vite SPA
frontend/embed.go      //go:embed all:dist
install.sh             릴리스 설치
.goreleaser.yaml       darwin/linux amd64/arm64, CGO_ENABLED=0
.github/workflows/     release.yaml 만 (태그 v*)
test/                  install.sh 체크섬 테스트, 재개 계약용 mock
```

보호된 API는 쿠키 미들웨어 뒤입니다. 공개면은 `POST /api/login`과 정적 SPA(`/`)입니다. 채팅 생성 JSON은 `{name, provider}`이고 `provider`는 omo로 해석되어야 합니다.

`v*` 태그를 푸시하면 릴리스 워크플로가 Go 1.26·Node 22로 프론트를 빌드하고 GoReleaser가 `omo-webchat_<os>_<arch>.tar.gz`와 `checksums.txt`를 올립니다. PR에서 `go test` / Vitest를 돌리는 워크플로는 없습니다.

### 개발과 테스트

```sh
go test ./...
cd frontend && npx vitest run
# 동일 비감시 실행:
cd frontend && npm test -- --run
sh test/install_checksum_test.sh
```

Makefile에 `test` 타깃은 없습니다. `cd frontend && npm test`는 Vitest 감시 모드이므로 CI 명령으로 쓰지 마십시오.

Vite 개발 서버는 `/api`를 `http://localhost:8080`으로 프록시합니다. `make run`은 이 프록시를 쓰지 않고 임베드된 SPA를 서빙합니다.

---

## English

### What it is

`omo-webchat` is a single Go binary (`./cmd/server`) that serves an embedded React SPA and talks to one launchable agent: the `omo` CLI, run as one shared multi-session RPC process (`omo --mode rpc --multi-session`) that hosts every chat as a logical session.

The HTTP server starts without omo. Creating a chat requires `omo` on `PATH`; otherwise the API returns `503` with `provider CLI is unavailable`.

omo is the only launchable provider. The UI always creates chats with `"omo"`. Persisted empty / `senpi` records are listed as omo. Any other persisted provider stays on disk and is hidden from listings.

### Features

- Password gate, then the SPA. `/api/*` needs the session cookie; the static UI at `/` does not.
- Workspaces group chats under a filesystem path. Workspace creation is limited to `--root`.
- New Chat creates immediately when `/api/providers` already reports omo available. The modal is only the loading / error / unavailable recovery UI. The server still refuses create if the binary is missing.
- Realtime chat over WebSocket, streaming assistant text, GFM markdown.
- `/` slash commands and `$` → `skill:<name>` palettes. Arrow keys, Enter/Tab insert, Escape dismisses; selecting a match does not send.
- `@` file mentions against the workspace cwd, bounded by `--root`.
- Model picker after omo reports models. Create does not send a model.
- Composer attach is **images only** (`image/*`), and is disabled when the current model reports no image input.
- The file browser uploads arbitrary files (picker or drag-and-drop) into the **workspace directory**. Browse / read / write / download / search resolve under `--root`.
- Approval requests are handled in a UI modal.
- Horizontal (`h`) and vertical (`v`) split panes, persisted in `state.json`. Split UI is off below `1024px`.
- Fonts: System, JetBrains Mono, Fira Code, IBM Plex Mono, Source Code Pro, Nanum Gothic Coding (Google Fonts).
- UI language: Korean / English. Language, font, and font size live in browser `localStorage`, not `state.json`.
- Mobile: 20s ping / 10s pong timeout, reconnect when the tab becomes visible, sidebar drawer at `max-width: 768px`.
- Live-session dots come from in-memory logical sessions (routing handles on the shared omo process), via `GET /api/sessions/live` polled every 4s. The list is empty after a server restart until a client reattaches.

### Requirements

**Runtime (downloaded binary)**

- `omo` on `PATH` to create chats. The server launches one shared `omo --mode rpc --multi-session` process; every chat lives on it as a logical session.
- tmux is not used.
- Release/install targets: macOS and Linux, amd64 and arm64. No Windows release.
- `--daemon` / `--status` / `--stop` work on darwin and linux only.
- Any modern browser that can hold a cookie and a WebSocket.

**Build from source**

- Go **1.26** (module language version and release CI).
- Frontend/release CI uses Node **22**. `frontend/package.json` does not pin `engines`. If you run frontend tests, use a Node that Vitest/jsdom accept.
- `make frontend` runs `npm ci` and `npm run build` (`tsc --noEmit && vite build`).

### Install (GitHub Releases)

```sh
curl -fsSL https://raw.githubusercontent.com/DevNewbie1826/omo-webchat/main/install.sh | sh
```

Needs `curl` and `tar`. Downloads `omo-webchat_<os>_<arch>.tar.gz` plus `checksums.txt`, verifies SHA-256 (`shasum -a 256` or `sha256sum`), and installs `omo-webchat` mode `0755` into `INSTALL_DIR`. Uses `sudo` only when neither that directory nor its parent is writable.

| Env | Default | Role |
|---|---|---|
| `VERSION` | `tag_name` from GitHub `releases/latest` | Pin a tag. Empty resolution fails and asks for `VERSION=vX.Y.Z`. |
| `INSTALL_DIR` | `/usr/local/bin` | Install path. Warns if it is not on `PATH`. |

Example pin:

```sh
curl -fsSL https://raw.githubusercontent.com/DevNewbie1826/omo-webchat/main/install.sh | VERSION=vX.Y.Z INSTALL_DIR=~/.local/bin sh
```

Re-running overwrites the binary in `INSTALL_DIR`. There is no separate upgrade path and no Windows installer.

Upgrading from `cli-webchat`: stop the old daemon first (`cli-webchat --stop`). Existing state under `~/.local/state/cli-webchat` is copied to the new location automatically on first run, and the original is left in place.

The script may still print a tmux warning. **The app does not use tmux; ignore it.**

### Build from source

```sh
make build
```

That is:

```sh
cd frontend && npm ci && npm run build
go build -trimpath -ldflags="-s -w" -o bin/omo-webchat ./cmd/server
```

Output: `bin/omo-webchat`. The SPA is embedded from `frontend/dist` at compile time, so a bare `go build ./cmd/server` embeds whatever is already in `dist` (or fails the embed). Use `make build`.

Local convenience only:

```sh
make run
```

Builds, then runs `./bin/omo-webchat --password dev123`. **`dev123` is a Makefile password, not a runtime default of the released binary.**

```sh
make clean
```

Removes `bin/`, `frontend/dist/assets`, and `frontend/dist/index.html`. It does not delete the whole `frontend/dist` tree (embed still needs it).

Release builds also set `CGO_ENABLED=0`. Local `make build` does not.

### Quick start

```sh
omo-webchat --password <secret>
```

From a source build: `./bin/omo-webchat --password <secret>`. With defaults, open `http://127.0.0.1:8080/` (or `http://localhost:8080`) and enter the password on the login page. Change `--host` / `--port` and the URL changes with them.

### Flags, env, precedence

For every flag-backed setting the **CLI flag wins**, because the environment value is only the flag default. An empty env string is treated as unset. `TH_PORT` is used only when `Atoi` succeeds; anything else falls through to `8080`.

| Flag | Env used as default | Hardcoded fallback | Required? | Purpose |
|---|---|---|---|---|
| `--host` | `TH_HOST` | `127.0.0.1` | no | Listen address |
| `--port` | `TH_PORT` | `8080` | no | Listen port |
| `--password` | `TH_PASSWORD` | `""` | **yes when serving** (foreground or `--daemon`) | Access password |
| `--root` | `TH_ROOT` | home directory | must exist when serving | File-browser / workspace-create root (`Abs` + symlink eval) |
| `--state-dir` | `TH_STATE_DIR` | none (see default dir below) | no | State directory (`Abs` + `Clean`, not symlink-evaluated; need not exist yet) |
| `--provider` | see below | `omo` | no | Must be `omo` when serving |
| `--daemon` | — | `false` | no | Spawn a background child |
| `--stop` | — | `false` | no | Stop the daemon; **no password** |
| `--status` | — | `false` | no | Probe the daemon; **no password** |

`--provider` env chain:

```
--provider
  > OMO_PROVIDER          (if non-empty)
    > GAJAE_PROVIDER      (if non-empty; legacy name)
      > omo
```

Only when serving: `senpi` is stored as `omo`; anything else after that rewrite refuses to start (`unsupported provider %q (only omo is accepted)`). `--stop` / `--status` skip provider and `--root` existence checks.

Cannot combine: `--daemon` with `--stop` or `--status`; `--stop` with `--status`.

Env-only equivalent (flags still win if both are set):

```sh
TH_PASSWORD=<secret> TH_PORT=8080 TH_HOST=127.0.0.1 TH_ROOT=~/projects TH_STATE_DIR=/path/to/state omo-webchat
```

Non-flag env:

| Env | Role |
|---|---|
| `XDG_STATE_HOME` | If **absolute**, default state dir is `$XDG_STATE_HOME/omo-webchat`. Relative values are ignored. Unused when `--state-dir` / `TH_STATE_DIR` is set. |
| Home directory | Default `--root`; default state `$HOME/.local/state/omo-webchat`; previous state `$XDG_STATE_HOME/cli-webchat` or `$HOME/.local/state/cli-webchat`; legacy `$HOME/.terminal-hub/state.json` |

### Security

- Default bind is `127.0.0.1` (same machine only).
- There is no in-process TLS (`http.Server` + `net.Listen("tcp")`).
- Cookie `th_session`: `Path=/`, `MaxAge=86400` (24h), `HttpOnly`, `SameSite=Strict`. **`Secure` is never set, on any bind address.**
- `POST /api/login` is public. The password is SHA-256 compared with `subtle.ConstantTimeCompare`.
- 10 failures per IP → 1 hour ban; further attempts while banned return `429` `too many failed attempts, try again later`. Client IP is `RemoteAddr` only; `X-Forwarded-For` is not trusted.
- Token: 32 random bytes, hex, sliding 24h TTL. Sessions are in-memory, so **a process restart requires login again**.
- JSON bodies 1 MiB, editor writes 2 MiB, uploads 100 MiB. `ReadHeaderTimeout` 10s.
- If a WebSocket `Origin` is present it must be a single `http`/`https` origin whose host equals `Request.Host`. A missing `Origin` is allowed.
- Binding off loopback is a deliberate `--host` / `TH_HOST` override. Put a TLS reverse proxy in front and do not expose plaintext HTTP. That guidance is not enforced in process.

### Daemon and state paths

darwin / linux:

```sh
omo-webchat --password <secret> --daemon
omo-webchat --status
omo-webchat --stop
```

`--daemon` still requires a password. The parent waits up to 3s for the child to listen, prints `omo-webchat started (pid N, http://host:port)`, and exits. `--stop` sends `SIGTERM` (wait 5s), then `SIGKILL` (wait 2s). It does not delete `state.json` or the log.

There is no systemd/launchd unit. The daemon does not start at boot.

State directory:

```
if --state-dir or TH_STATE_DIR is set:
    abs(clean(value))          # no XDG, no legacy migration
else:
    absolute XDG_STATE_HOME →  $XDG_STATE_HOME/omo-webchat
    otherwise               →  $HOME/.local/state/omo-webchat
```

| File | Mode | Role |
|---|---|---|
| `state.json` | `0600` (write `.tmp`, rename) | Workspaces, chats, split layout |
| `omo-webchat.pid` | `0600` | Daemon PID |
| `omo-webchat.log` | `0600` append | Daemon stdout/stderr |
| `omo-webchat.lock` | `0600` + flock | Single daemon |

The directory is `0700`.

On the default path only: if the new `state.json` is missing, two previous locations are tried in order and the first existing source is copied byte-for-byte once: (1) `$XDG_STATE_HOME/cli-webchat/state.json` when `XDG_STATE_HOME` is absolute, otherwise `$HOME/.local/state/cli-webchat/state.json`; (2) `$HOME/.terminal-hub/state.json`. Every original stays untouched; nothing is rewritten, renamed, or deleted. An existing new file wins, so no migration happens then. `--state-dir` / `TH_STATE_DIR` skips migration.

omo does not outlive the server (process group kill). After restart, attach starts a new shared omo process and sends `open_session` with the persisted `piSessionId` as `sessionPath`. If that resume fails, the stored path is dropped and a fresh logical session opens with the chat's `cwd`. That is conversation-identity resume, not a surviving OS process. Because every chat shares that one process, a provider failure takes down all active logical sessions at once, not just one chat.

Browser-only keys: `th-lang` (`en` / `ko`), `th-font`, `th-font-size` (10–24, default 13).

### Architecture

```
cmd/server/            flags → daemon verbs or api.Run
internal/config/       flag + env load
internal/daemon/       unix start/stop/status + lock; stub elsewhere
internal/auth/         in-memory sessions, brute-force, cookie
internal/store/        state.json load/save/migrate
internal/chat/         shared multi-session omo process, open/close_session, handle routing
internal/api/          HTTP, WebSocket, filesystem, workspaces
frontend/              React 18 + Vite SPA
frontend/embed.go      //go:embed all:dist
install.sh             release installer
.goreleaser.yaml       darwin/linux amd64/arm64, CGO_ENABLED=0
.github/workflows/     release.yaml only (tag v*)
test/                  install.sh checksum test and resume-contract mock
```

Authenticated routes sit behind the cookie middleware. Public surfaces are `POST /api/login` and the static SPA (`/`). Create-chat JSON is `{name, provider}`; `provider` must resolve to omo.

Pushing a `v*` tag runs the release workflow (Go 1.26, Node 22, GoReleaser) and publishes `omo-webchat_<os>_<arch>.tar.gz` plus `checksums.txt`. There is no PR workflow that runs `go test` or Vitest.

### Development and tests

```sh
go test ./...
cd frontend && npx vitest run
# same non-watch form:
cd frontend && npm test -- --run
sh test/install_checksum_test.sh
```

There is no Makefile `test` target. `cd frontend && npm test` is Vitest watch mode; do not treat it as the suite command.

The Vite dev server proxies `/api` to `http://localhost:8080`. `make run` does not use that proxy; it serves the embedded SPA.
