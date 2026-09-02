# v2 3단계 이상 상태 — WS 계약 단일 소스 + Go/TS 생성 + lib/ 재작성

작성: 2026-09-02 · 근거: explore 실측(lib/ 18파일 판정, v1 WS 계약 사실, v2 Frame API, 20개 계약 요구사항 R1-R20, features/→lib/ 통합 이음새 ~30 심볼)

## 선언

1. **계약은 단일 소스에서 나온다**: `contract/` JSON Schema(프레임 20종 서버→클라 + 13종 클라→서버, 공유 UI 타입, 오류 코드, notice 내구 종류, entries 페이징, ack/control.result 상관) — Go 생성 타입(브리지가 직렬화에 사용)과 TS 생성 타입(lib/가 소비)이 같은 스키마에서 나오고 roundtrip 테스트가 그 사실을 증명한다.
2. **와이어 이름은 v1 연속성을 유지**: `messageDelta`/`chat.name`/`run.started`... (프론트가 이미 분기하는 값). v2 FrameKind(`message.delta`/`name`...)와의 매핑은 브리지가 소유.
3. **v2 WS 브리지**(신규 `internal/wsbridge`): session.Manager + cursorstore 위에 WS 엔드포인트. 업그레이드(origin 정합/deflate), 인증(internal/auth 재사용), 클라 메시지→Manager 호출, Frame→생성 와이어 타입 직렬화, 부착 시 ActivitySnapshot 재생(스냅샷-후-라이브). v1 api 라우터에 **한 줄 등록**(additive).
4. **lib/ 재작성, 이음새 보존**: `ws.ts`/`chatWs.ts`/`chatWsParse*.ts`는 생성 타입 기반으로 새로 쓰되 **같은 export 심볼**(connectChat, ChatServerFrame/ChatClientFrame, ChatConnector/ChatClient, parseChatServerFrame-null-패턴, sanitizeJson, 필드 검증기, 공유 UI 타입)을 유지 — features/ 트리와 기존 features 테스트는 한 줄도 수정 없이 통과. 백오프/하트비트/가시성 프로브/인증 만료 프로브는 ws.ts 패턴 이관.
5. **unknown 프레임 포워드 호환**(R1), **스키마 버전 필드**(hello 프레임) — 서버/클라 버전 불일치는 경고 후 진행.

## 파일 판정 (explore 확정)

KEEP: api.ts, path.ts, theme.ts, font.ts, useMediaQuery.ts · ADAPT: chatWsParseFields.ts(방어 패턴 유지, ResumeCandidate는 스키마로) · REWRITE: ws.ts, chatWs.ts, chatWsParse*.ts (전부 v1 프레임 특정) — 단 REWRITE 파일들의 **export 목록은 동일**하게.

## 수용

- roundtrip: 같은 스키마에서 생성된 Go 직렬화 ↔ TS 파싱이 샘플 프레임 전종에서 일치 (계약 파일이 곧 테스트 픽스처)
- wsbridge 통합: httptest + omorpctest 목 데몬으로 실서버 전체 흐름(바인드→프롬프트→스트림→정착→재접속→스냅샷)
- features/ 테스트 무수정 통과 + `npx vitest run` 전체 green + `go test ./...` green

## 범위 밖 (4단계)

REST 라우트 재배선(현황판/상태창 데이터 표면), v1 chat.go/ws.go 교체, features/ 내부 수정.
