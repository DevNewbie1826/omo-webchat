# v2 2단계 이상 상태 — 세션 오케스트레이션 + 커서-온리 저장소

작성: 2026-09-02 · 근거: v2 재설계 방향 합의, PR #24(82a0ca3, internal/omorpc) 배송 완료, docs/v2/{ideal-state,v1-map,invariants}.md

## 이 PR이 만드는 상태 (선언)

`internal/omorpc` 위에 **세션 오케스트레이션 층**과 **커서-온리 저장소**를 얹는다. 이 두 개가 합쳐져 v1의 이중 기장(omo 세션 파일 vs 우리 state.json 병렬 추적)이 구조적으로 제거된다 — 저장소에는 **재개 포인터만** 있고 트랜스크립트·액티비티 스냅샷·공지 재생 시드는 전부 없다.

```
internal/session   매니저(에포크/커서, 채팅→세션 핸들) + 세션(명령, 실행 래치)
                   ↓ 내부에서만 사용
internal/omorpc    소켓 클라이언트 (PR #24)
internal/cursorstore  chatId→{sessionFile, durableSessionId, cwd} + 워크스페이스 메타 + 레이아웃
```

## internal/session — v1에서 이관하는 것 / 버리는 것

**이관 (client-owned, 전송 무관):**
- 실행 래치: `agent_settled`만 종료 이벤트 (invariant 1/16)
- 프롬프트 게이트: 실행/컴팩션 중 SendPrompt 즉시 거부 (2/16)
- 재개 prove-before-clear: 실패해도 커서 불변, dangling 분류 (7)
- `session_path_in_use` 일시적 재시도: 동일 요청 3회/백오프 (7/8)
- idle 대비 = '재개 가능' 정식 상태, `session_unloaded` 정확히 1회 (4/11)
- 이벤트→클라이언트 매핑 + 스냅샷-재생-후-라이브 순서 (17)

**버림 (transport-owned, stdio 소유라 소켓에 없음):**
- exit/identity 게이트, pre-open 버퍼, 프로세스 수거/그룹 킬, stderr 캡처, provider 사망 대피의 프로세스 성격(→ epoch 무효화가 대체)

## 저장소 계약 (커서-온리)

- 레코드: `{chatId, workspaceId, cwd, sessionFile, durableSessionId, name, nameSource, createdAt, lastUsedAt}` — **ActivitySnapshot/Notices/LastEntryID/PiSessionID 같은 재생 시드 전면 부재**
- 워크스페이스 메타데이터 + 레이아웃 JSON 포함, 원자적 temp+rename 쓰기 (v1 저장 메커닉 개념 이관)
- 마이그레이션 없음: v1 state.json과 병렬 존재 (컷오버 PR에서 일방향 임포트)

## 수용 데모 (C001)

목 데몬 통합 테스트: 채팅 생성 → `open_session{sessionPath}` → 프롬프트 → 스트림 → 정착 → 커서 영속 확인 → **클라이언트(서버) 재시작** → 커서로 `open_session{sessionPath}` 재개 → durable id 일치 검증. 서버 재시작 후에도 대화가 이어지는 것이 이 층의 존재 이유.

## 의사결정 (확정)

| 항목 | 결정 |
|---|---|
| v1 무변경 | internal/session·cursorstore은 v1 호출자 0 (additive-only) |
| API 재배선 | 이 PR 범위 밖 — 다음 PR (WS 계약 설계와 함께) |
| 패키지명 | internal/session (orchestration), internal/cursorstore (저장) |
| 세션 이벤트 구독 | omorpc Client.Events() 소비, 세션별 디멀티플렉스, 구독자 큐는 하드 바운드 (omorpc 정책과 동일) |
