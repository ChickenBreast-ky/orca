# Orca Kyle 후속 작업 큐

각 항목은 나중에 orchestration 카드로 만들어 진행한다. 카드로 승격되면 해당 항목에 Run/카드 ID를 적고 상태를 바꾼다.

## 1. 미배정(inbox) 카드 일급 모델 — 정석 수정

- Why: 생각난 작업을 TODO 파일·이슈·대화에 흩뿌리면 나중에 "카드로 옮겼는지"를 사람이 기억해야 한다. 카드 원장(`orchestration.db`)이 이미 존재하므로, 미배정은 새 공간이 아니라 원장 위의 상태값이어야 한다. 사이드바를 지저분하게 만들지 않으면서 "아무도 안 잡은 일"을 드러내는 게 목표다.
- 현재 제약(2026-08-03 실측): `tasks.run_id`가 `TEXT NOT NULL DEFAULT 'run_legacy_local'` (src/main/runtime/orchestration/db.ts:309, 458, 480, 505, 691 등 다수 테이블). 카드는 반드시 Run에 속해야 하므로 "감독 미정 카드"를 적재할 곳이 없다.
- 설계 방향 (kyle 확정 2026-08-03):
  - `tasks.run_id`를 nullable로 마이그레이션 — Run 미소속 카드 허용
  - 별도 플래그 추가: `assignment_state TEXT NOT NULL DEFAULT 'assigned'`, 값은 `inbox / assigned` (향후 `archived` 등 확장 여지)
  - `run_id IS NULL`만으로 미배정을 판단하지 않고 명시 플래그를 둔다 — 쿼리·인덱스·UI 분기가 단순해지고 "인계됐지만 감독 죽음" 같은 회귀 상태도 표현 가능
  - `task-create`에 `--run` 없이 만들면 `run_id = NULL`, `assignment_state = 'inbox'`로 적재
  - 사이드바 Run 트리는 그대로 유지, `inbox` 개수만 작업 섹션 배지로 표시. 배지 클릭 시 미배정 목록 → 감독 판으로 인계
  - 감독 인계 시 `run_id` 연결 + `assigned` 전환. 카드 ID 불변이라 이력이 끊기지 않음
  - 기존 DB의 `run_legacy_local` 카드는 건드리지 않고 새 기본 동작만 추가. 조회 쿼리는 `run_id IS NOT NULL` 기본 조건으로 기존 화면 동작 보존
- 검증: 마이그레이션 전후 기존 카드 목록 동일성, inbox 생성→인계→완료 왕복, 기존 Run 트리 화면 회귀 없음
- 금지: 숨겨진 inbox Run을 상주시키는 임시 우회(1번 안)를 정석처럼 문서화하지 않는다
- 참고: 원장 위치는 포크본 `/Users/fw_m1/Library/Application Support/Orca Kyle/orchestration.db` (구 오르카 `~/Library/Application Support/orca/orchestration.db`와 분리됨, 2026-08-03 기준 신규 작업은 포크본에만 기록)

## 2. 비활성 워크트리 에이전트 스피너 미표시

- 증상 (kyle 제보 2026-08-03): 에이전트로 판정되지 않는 터미널은 사이드바 스피너가 안 돌다가, 해당 브랜치(워크트리 카드)를 클릭하면 그제서야 스피너가 나타난다. 진행 표시가 클릭에 의존하면 정체·폭주 감지가 늦어진다.
- 이미 카드 생성됨: Run `run_d5fa5131a1b0`, 카드 `task_78b7ce444fe6` (감독 미배정 상태 — 1번 inbox 모델이 생기면 첫 적용 후보)
- 실측 근거:
  - `useWorktreeAgentRows(worktreeId, active)`는 active=false면 빈 배열 반환 (src/renderer/src/components/sidebar/useWorktreeAgentRows.ts)
  - 행은 working|blocked|waiting 훅 항목만 생성 (worktree-agent-rows.ts)
  - freshness signature는 agentStatusEpoch 캐시 (worktree-agent-freshness-selector.ts)
  - bootstrap 워크트리 실측: 터미널 22개 연결, 훅 상태는 done 16 / working 1뿐
- 조사 분기: (a) 비활성 워크트리의 훅 이벤트가 renderer store에 클릭 전엔 반영되지 않는가 (b) 반영되지만 행 계산 active 게이트가 막는가
- 가드레일: `done` 세션 상시 표시·카운트를 터미널 수로 바꾸는 재설계 금지

## 3. 판 종료 시 UI 표면 정리(GC) — 작업 탭과 워크스페이스

- Why: 판이 끝나도 UI에는 그 판의 흔적이 그대로 남는다. CLI 장부에서는 이미 사라졌는데 화면에만 죽은 작업 탭이 쌓여 있고(2026-08-04 실측 약 30개), 사용자는 어느 탭이 살아 있는 판인지 매번 눈으로 골라내야 한다. 끝난 표면은 판을 닫을 때 공식 절차로 치워야 한다.
- 범위: 판(Run/board) 종료 시 (a) 그 판이 만든 작업 탭 (b) 그 판이 만든 worktree 및 folder workspace를 UI에서 공식적으로 정리한다.
- 필수 조건:
  - **사용자 확인 후 실행.** 무엇을 닫는지 목록을 먼저 보여주고, 보존을 선택한 항목은 남긴다. 산출물이 있는 worktree는 기본 보존 쪽으로 제안한다.
  - **다른 판·운영 프로세스 불개입.** 정리 대상은 종료하는 판이 만든 표면만이다. 다른 `[판:]`의 탭, 명패, 프로젝트 감독, 중계기, 앱 밖 프로세스는 대상에서 제외한다.
  - **worktree 삭제는 기존 관문 규칙을 그대로 탄다.** UI GC가 승인 절차를 우회하는 경로가 되면 안 된다.
  - macOS / Linux / Windows 모두에서 동작해야 한다. 경로 조립은 `path.join`, 프로세스 종료는 플랫폼 분기.
  - SSH 워크스페이스와 folder workspace를 함께 지원한다. 모든 워크스페이스가 git worktree라고 가정하지 않는다.
- 검증 기준: 판 종료 전후 (1) 남은 탭 목록이 사용자가 보존 선택한 것과 정확히 일치 (2) 다른 판의 탭·터미널 수 변화 0 (3) folder workspace와 SSH 워크스페이스 각각에서 왕복 1회 (4) 보존 선택한 worktree가 디스크에 그대로 (5) 정리 후 CLI 장부와 UI 탭 목록의 불일치 0건.
- 이번 범위 밖: UI 구현 자체. 이 항목은 계약과 검증 기준까지만 확정한다.

## 4. 포크 동기화 리듬 — upstream 미러 / 정기 동기화 랠리 / 즉시 cherry-pick

- Why: 포크가 upstream에서 오래 떨어질수록 나중에 한 번에 합칠 때 위험이 커지고, 그렇다고 매번 따라가면 운영 앱이 흔들린다. 주기를 고정해 "떨어짐"과 "흔들림" 둘 다 막는다. 기준선·태그 판정 절차 자체는 [`orca-kyle-maintenance.md`](./readme/orca-kyle-maintenance.md)를 따르고, 이 항목은 **리듬**만 정한다.
- 리듬 3종:
  1. **주 1회 — upstream → `main` 미러.** 무선별 fast-forward만. 충돌이 나거나 ff가 아니면 그 주는 미러를 건너뛰고 기록만 남긴다. 미러는 `main`을 최신 기준본으로 유지하는 것이 목적이고, 운영 앱은 건드리지 않는다.
  2. **월 1회 — `main` → `bootstrap` 정기 동기화 랠리.** 순서 고정: 머지 → 테스트 → 로컬 빌드 → QA 실기동 E2E → 검수 PASS. **검수 PASS 뒤에만 운영 앱을 교체한다.** 앞 단계 중 하나라도 실패하면 그 달 교체는 없고 기존 운영 앱을 유지한다. 실기동 E2E와 앱 교체는 위 "운영 앱 E2E 재기동 절차"를 그대로 쓴다.
  3. **[P0]·보안 픽스는 즉시.** 월 랠리를 기다리지 않고 해당 커밋만 개별 `git cherry-pick -x` 한다. 전체 동기화로 확대하지 않는다.
- 금지: upstream `main` 자동 병합, 검수 PASS 전 운영 앱 교체, 월 랠리 안에 무관한 변경 끼워넣기.

## 5. 결함 A 제품 수정 — `terminal create --role` 등록 실패가 조용히 숨는다

- Why (2026-08-04 실증): 후임 중계기를 `--role`로 만들었을 때, 같은 identity에 active 레코드가 이미 있으면 roster 등록이 **조용히 건너뛰어졌는데도** receipt는 `ok=true`였다. 감독은 등록됐다고 믿고 교대를 진행했고, 실제로는 `roster list`·`roster show`에 후임이 없어 교대가 실패했다.
- 실측 경로:
  - `src/main/runtime/orchestration/role-roster-creation.ts:117` — 사전 검사 `assertRoleRosterIdentityAvailable`은 `params.terminal`이 있을 때(기존 pane 재사용)만 돈다. 새 터미널 생성은 이 시점에 pane이 없어 검사를 통과한다.
  - 같은 파일 `:127-138` — 실제 기록은 발령 준비가 끝난 뒤에 일어나고, identity 충돌 오류는 `console.warn`으로 삼켜진다. 호출자에게 실패가 전달되지 않는다.
  - `src/cli/handlers/terminal.ts:163-186` — receipt는 `RuntimeTerminalCreate`(handle·title 등)뿐이고 roster 등록 여부를 담는 필드가 없다.
- 요구 사항: 등록 실패는 **fail-closed(생성 자체를 실패)** 또는 **명시적 경고**여야 한다. 어느 쪽을 택하든 receipt에 **등록 여부(`registered`)를 반드시 싣는다** — 호출자가 확인할 수단이 없는 지금이 사고의 핵심이다.
- 주의: `:97-100`의 기존 주석은 "발령 준비 후 실패는 살아 있는 작업자를 고아로 만든다"는 이유로 늦은 실패를 warning으로 낮췄다. 그 이유 자체는 유효하므로, 해결은 "warning을 error로 바꾸기"가 아니라 **검사 시점을 앞당기거나 결과를 receipt로 노출하는** 쪽이어야 한다.
- 검증 기준: identity 충돌 상태에서 `terminal create --role` 왕복 1회 — receipt의 등록 여부가 `roster list` 실제 결과와 일치할 것. 충돌 없는 정상 생성 경로 회귀 없음.
