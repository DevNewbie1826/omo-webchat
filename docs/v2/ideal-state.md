# v2 이상 상태 (Ideal State) — 근거 기반 정의

작성: 2026-09-02 · 이 문서는 v2 리빌드의 판금 기준이다. 근거: omo RPC 프로토콜 라이브 검증(2026-08-29 설치 CLI 실측 + 2026-09-02 rpc.sock 프로브), v1 코드/git 히스토리 실측(최근 60커밋 중 34 fix = 기초 불안 세금).

## 현재 문제 (진단)

1. **이중 기장**: internal/store의 Chat 레코드(PiSessionID/SessionDir/LastEntryID/ActivitySnapshot/Notices)가 omo 엔진의 세션 파일 상태를 복제해 추적 → 드리프트가 안정성 문제의 뿌리.
2. **수명 결합**: 서버가 omo 프로세스를 stdio 자식으로 소유 → 서버 재시작이 에이전트 사망을 강제. 재시작/고스트/좀비 버그 클래스의 온상.
3. **기능마다 반복 청구되는 보상 세금**: 배지·공지·카운트 각각이 기초 불안을 게이트로 보정(34/60 fix).

## 이상 상태 (선언)

1. **트랜스크립트 소유자는 엔진 하나**: 웹챗은 open_session(sessionPath=우리 stateDir 하위)으로 경로를 지정, 병렬 기록 없음. 저장소는 커서({chatId → sessionFile, durable sessionId, cwd}) + 워크스페이스 메타데이터만.
2. **전송은 Unix 소켓 데몬**: `~/.omo/agent/rpc/rpc.sock`에 접속. 데몬 부재 시 ensure(supervisor spawn). 서버 재시작과 에이전트 수명이 분리 — **채팅 중 서버를 죽여도 세션이 살아있고 재접속하면 이어진다** (헤드라인 수용 데모).
3. **히스토리는 단방향 읽기**: 라이브=get_entries, 콜드=세션 JSONL 그래프 리드(leafId→parentId). 우리→엔진 쓰기는 커맨드뿐.
4. **계약은 타이핑된 단일 소스**: 명령/이벤트/안정 에러코드 8종(unknown_session, session_closing, session_path_in_use, missing_session_id, multi_session_disabled, invalid_path, too_many_sessions, open_failed:*)이 스키마에서 생성되어 Go+TS가 공유. unknown 이벤트는 포워드 보존.
5. **epoch/durable 세션 id 이원화**: 라우팅은 epoch-local("rpc-N"), 영속은 durable UUID. 소켓 상실 = epoch 무효화 = 전 세션 "재개 가능" 상태(정식 프로토콜 상태, 패치 아님).
6. **v1 런타임과 무관한 신규 패키지로 시작**: internal/omorpc은 v1 internal/chat에 한 줄도 손대지 않고 들어온다. 교체는 후속 PR에서 라우트 단위로.

## 주요 의사결정 (전부 합의 완료)

| 결정 | 내용 | 근거 |
|---|---|---|
| 재구축 범위 | 백엔드 internal/ 0% 재사용, 원스샷 컷오버 | git 실측 + 사용자 확정 |
| 프로토콜 | rpc multi-session (app-server 기각: get_commands/extension_ui_request/get_session_stats 소실+히스토리 손실) | 2026-08-29 라이브 검증 |
| 전송 | Unix 소켓 + detached 데몬 | rpc.sock 라이브 프로브: 데몬이 서버 재시작과 무관하게 생존 실측 |
| 언어 | Go (단일 바이너리 배포 우위) | 배포 파이프라인 유지 |
| 프론트 | 레이아웃·디자인 뼈대 유지, 데이터 표면은 새 계약에 맞춰 자유 재배선(호환 심 없음) | 사용자 확정 |
| 미채택 | 이벤트소싱/클라우드 인증/릴레이/멀티프로바이더/Effect 프레임워크 | 현재 요구사항에 없는 문제를 푸는 장비 |

## 이 PR (첫 조각)의 완료 정의

internal/omorpc 패키지: 프로토콜 타입 + 소켓 클라이언트(dial/JSONL/id 상관/epoch) + 데몬 ensure(capability 게이트/백오프) + 소켓 모드 목 데몬 픽스처 + 본 문서와 불변량 문서. TDD(RED→GREEN), v1 무변경, go test ./... 전체 green, 리뷰 승인 후 병합.
