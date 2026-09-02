# v2 4단계 이상 상태 — 데이터 표면 재배선 마무리

작성: 2026-09-02 · 근거: explore 실측(6개 표면 지도, REST 분류, 갭 4건, 테스트 영향 분석). main = 86569ef.

## 발견: 재배선의 대부분은 이미 완료됨

3단계 제어평면 통합(PR #26)이 live 목록 병합·삭제·이름변경·워크스페이스 커버를 이미 수행했다. 표면들의 와이어 호환이 유지되어 프론트 churn은 낮다. 남은 것은 **데이터 완결성 3갭 + 다이제스트 풍부화**다.

## 이 PR의 범위

1. **사이드바 트리 무음 누락 수정** (Go): `handleListWorkspaceSessions`이 store만 읽음 → cursorstore와 union. v2 세션이 트리에 안 보이는 것은 무음 데이터 손실.
2. **v2 Summary 풍부화** (Go): `session.Summary`에 `Title`, 활동 `Pair`(task/dag 스냅샷), `TaskDigest`/`DagDigest`, oversized 플래그 추가 — v2 세션의 현황판 표시등/요약이 v1과 동등해짐. Session이 이미 유지하는 활동 스냅샷 캐시에서 파생.
3. **v2 채팅 업로드 경로** (Go): `POST .../chats/{chatId}/upload`가 v2 채팅에서도 동작(파일 저장은 엔진 무관 — 경로 확인만).
4. **프론트 검증 적응** (TS): enriched Summary 형상 반영 테스트 갱신 + C002 엣지(빈 상태/로딩 실패/재연결 후 표면 복구) 테스트. 레이아웃 뼈대 0변경.
5. **갭 원장 문서화** (docs): 갭별 결정 — 프레임 확장/REST/의도적 제거/이연 — `sessions.subscribe`(배경 세션 WS 푸시)는 **5단계 이연 결정** 명시.

## 명시적 범위 밖 (5단계)

- `sessions.subscribe` 브리지 프레임 세트(배경 세션 활동 WS 푸시) — 4s REST 폴링이 갭을 채움
- v1 엔진 제거/스위치, `/api/ws` 폐지

## 수용

- union 후 v2 세션이 트리에 보임; enriched Summary로 현황판 표시등/다이제스트가 v2 세션에서 동작; 업로드 v2 동작; vitest 전체 green(갱신 포함); go test green; 갭 원장 문서 존재.
