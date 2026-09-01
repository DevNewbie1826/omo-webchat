# v1 엔진 맵 — 책임, 공개 심, 불변량 (explore 산출물)

작성: 2026-09-02 · explore 에이전트 실측 (internal/chat 전 파일 + 테스트 + mock-pi 분석)
역할: v2 교체 범위의 참조 명세. 불변량의 정식 목록은 invariants.md가 주인이다.

## 1. 책임 맵 (교체 판정 포함)

| 클러스터 | 파일 | 하는 일 | v2 판정 |
|---|---|---|---|
| 프로세스 관리 | process.go, process_group_unix.go, process_stream.go | stdio 펌핑, 유한 쓰기 큐(64), 10s 쓰기 데드라인, stderr 회전 캡처(2x10MiB), 프로세스 그룹 SIGKILL, exit 분류 | **삭제** — 소켓이 전부 대체 |
| 프로토콜 표면 | protocol.go | 38개 프레임 구조체 + ParseClientFrame + CommandEntry 매핑 | **개념 이관** — 어휘 동일, omorpc로 이동 |
| 공유 프로바이더 | shared_provider*.go, manager_provider_exit.go | 단일 멀티세션 프로세스 소유, requestId 상관, 세션별 전달 큐+워커+파수견, 원자적 프로바이더 사망 대피, idle 대피 | **삭제** — 소켓 클라이언트가 대체 (전달 큐/워커 불필요) |
| 세션 수명 | session.go, session_dispatch.go, session_commands.go | promptInFlight/providerRunActive/compaction 게이트, run.started/done, sendControl 배리어 | **개념 이관** — 래치는 클라이언트 동시성 관리라 살아남 |
| 액티비티/공지 투영 | activity_snapshot.go, activity_reconcile.go, notice*.go | 작업/DAG 캡시(64KiB), 고스트 강등, durable 공지 링(50, 허용목록) | **개념 이관** — 콜백 경계(OnActivitySnapshot/OnNoticePersist) 유지 |
| 엔트리 페이징 | entries_paging.go | ≤256KiB/≤100엔트리 페이지, entries.stream 재조립 | **개념 이관** — 전송 무관 |
| 브로드캐스터 | broadcaster.go | 다중 구독 팬아웃, 취소 가능 쓰기(5s), 부착 시 스냅샷 재생 | **개념 이관** — 프로바이더 전송과 직교 |
| identity/exit 게이트 | identity_gate.go, exit_gate.go | 등록 전 도착 이벤트 버퍼링 | **삭제** — 소켓 epoch에 이 문제 없음 |
| 락 질서 | manager.go 주석 | Session.lifecycleMu → Manager.mu → sharedProvider.mu → Session.mu; I/O/채널 수신 중 홀드 금지 | **개념 이관(수정)** — sharedProvider.mu 소멸, 3개 남은 순서 문서화 |
| 프로바이더 레지스트리 | provider.go, provider_capabilities.go | omo 1종, SENPI_RPC_CLIENT_CAPABILITIES 주입 | **개념 이관** — 생성된 데몬의 환경 변수로 주입 |

## 2. 공개 심 (internal/api가 소비 — v2 클라이언트가 결국 제공할 표면)

- 타입: Provider, FrameWriter(+Canceller), ClientFrame/ErrorFrame/RunDoneFrame/ApprovalFrame/ExtensionEventFrame/NoticeFrame/ControlResultFrame/Compaction*/RunStartedFrame, ActivitySnapshotPair, SessionOptions, ResumeIdentity, 콜백 인터페이스들
- Manager: AcquireAttach(ctx, opts, writer)→(session, started, detach, err), Get, LiveSummaries, Stop, CloseAll
- Session: Abort, SendPrompt(게이트 에러 반환), SetModel/SetThinking(ack), Query{Commands,Stats,Models,State}, SetSessionName, RespondApproval, Compact, Attach→detach, Close
- 콜백: OnActivitySnapshot, OnNoticePersist, OnResumeIdentity, OnResumeFailure, OnProviderName, OnExit, ProviderContext
- WS 프레임: error, run.done/started, compaction.started/done, state, models, commands, stats, approval, notice, extensionEvent, entries, control.result, chat.name, message, messageDelta

## 3. 불변량 10 (인용: omo_lifecycle_test.go, idle_eviction_test.go, manager_resume_safety_test.go, lifecycle_test.go, contracts_test.go)

1. **agent_settled만 종료** — agent_end(willRetry:false 포함)는 절대 종료 아님; run.done는 settled에서만
2. **프롬프트 게이트** — provider run/compaction/로컬 명령 중 SendPrompt 즉시 거부(ErrPromptInFlight/ErrCompactionInFlight), 프로바이더 미접촉
3. **IsFinished는 provider 래치 추적** — provider 주도 run(wake)도 settled까지 미완료 처리
4. **idle 대비** — 엔진 close_session 응답이 대비 신호, session_unloaded 에러 정확히 1회, 저장 identity로 재개(cwd 아님)
5. **종료 프레임은 lifecycleMu 홀드 하 발행** — 경합 Acquire가 미완료를 완료로 오인 방지
6. **락 질서 준수** — 어떤 락도 provider I/O/채널 수신 중 홀드 금지
7. **세대 리스** — 디스크 I/O가 무관 Manager 연산 차단 금지
8. **session_path_in_use 일시적** — 3회까지 500ms 백오프 재시도, 저장 identity 불변
9. **영구 재개 실패 시 저장 identity 절대 변이 금지** — resume_failed+Dangling=true, 새 cwd 세션
10. **Session.Close는 abort 쓰기 없이 cancel 우선** — stdin 막힘 교착 방지

## 4. 목-파이 표면 → 소켓 모드 목 데몬 요구사항

제어: get_protocol_info/open_session/close_session/list_sessions. 세션별: prompt/steer/follow_up/abort/get_state/get_available_models/set_model/set_thinking_level/get_commands/get_session_stats/get_entries(스트리밍)/new_session/switch_session/extension_ui_response/compact. 이벤트: agent_start/end/settled, turn_start/end, message_start/update/end, extension_ui_request, compaction_start/end, commands_changed, extension_event, response.

환경변수 시나리오(소켓 목 데몬이 미러할 것): MOCK_PI_WAKE_TURN(주도 run), MOCK_PI_LOCAL_PROMPT(확장 로컬 명령), MOCK_PI_CHUNK_MODE=signal(수동 청크 해제 — 실행 중 거부 시험), MOCK_PI_EXT_EVENT(작업/DAG+이름없는 이형 이벤트), MOCK_PI_APPROVE(승인 요청), MOCK_PI_TOOL, MOCK_PI_HOOK, MOCK_PI_SWITCH_FAIL, MOCK_PI_HOLD(abort 시험), MOCK_PI_RESUME_CONTRACT(재개), MOCK_PI_COMPACT_STALE_A_SCENARIO(타 세션 컴팩션 지연 응답).

## 5. 재구축 팀 지침 (explore 결론)

1. protocol.go 프레임 어휘가 이미 완전 — 스키마 원천으로 사용
2. shared_provider+process+process_group → omorpc 소켓 클라이언트(~/.omo/agent/rpc/rpc.sock, JSONL, sessionId 디멀티플렉스)
3. Manager/Session은 프로세스 소유권만 잃고 순수 클라이언트 오케스트레이션으로 생존
4. 지속 콜백 3종은 저장소 쓰기 경계로 생존
5. 목 데몬은 같은 프레임 순서+같은 환경변수 변주
6. 락 질서 단순화(sharedProvider.mu 소멸)는 패키지 주석에 명시
7. 세대 리스는 감축 가능성 검토
