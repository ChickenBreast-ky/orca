# Orca Kyle 설치·실행·복구

## Why

공식 Orca와 나란히 쓰는 포크이므로, 어느 데이터가 어느 앱 것인지 헷갈리지 않게 경로와 복구 방법을 한 곳에 고정한다.

## 경로

| 목적 | 경로 |
|---|---|
| 소스 | `/Users/fw_m1/Dev/orca-kyle` |
| 포크 데이터 | `/Users/fw_m1/Library/Application Support/Orca Kyle` |
| 포크 개발 데이터 | `/Users/fw_m1/Library/Application Support/orca-kyle` |
| 이관 QA | `/Users/fw_m1/Library/Application Support/Orca Kyle QA` (0700, Git 추적 금지) |
| 공식 앱 | `/Applications/Orca.app` (읽기 전용) |
| 공식 데이터 | `/Users/fw_m1/Library/Application Support/orca` (포크 쓰기 금지) |
| 포크 CLI | `orca-kyle`, `orca-kyle-dev` |
| 공식 CLI | `orca`, `orca-dev` (건드리지 않음) |

## 빌드와 실행

```bash
pnpm install --frozen-lockfile
pnpm build:mac
open -n "dist/mac-arm64/Orca Kyle.app"
```

- 서명은 로컬 개발/ad-hoc만 허용한다. Developer ID 배포 서명·공증은 하지 않는다.
- 앱 내 업데이트는 모두 비활성화다. 새 버전은 이 저장소에서 수동 빌드로만 만든다.

## 이관 QA(공식 데이터 복사 시험)

1. 공식 Orca와 데몬을 정상 종료한다.
2. 공식 `userData` 전체를 `Orca Kyle QA/golden/<attempt>`에 복사하고 해시 목록을 기록한다.
3. golden에서 candidate를 파생하고 socket/PID/token 등 실행 파일을 제거한다.
4. candidate만 포크로 열어 스키마 이관을 확인한다.
5. 종료 후 공식 해시 목록이 처음과 같은지 비교한다.
6. candidate를 공식 위치로 되돌려 쓰지 않는다.

## 복구

- 포크를 쓰지 않게 되면 포크 앱과 `Orca Kyle` 데이터를 두고, 손대지 않은 공식 Orca를 그대로 열면 된다.
- 공식 데이터는 항상 읽기 전용 기준본이다. 포크가 공식 경로를 가리키면 DB를 열기 전에 시작이 막힌다.

## 운영 앱 E2E 재기동 절차

### Why

새 빌드를 운영 앱에 태우려면 결국 한 번은 앱을 껐다 켜야 한다. 그런데 이 작업은 실행자가 자기가 죽일 대상 안에 살고 있으면 절반만 실행되고, 강제 종료로 끄면 열려 있던 데이터가 어떤 상태로 남는지 확인할 수단이 사라진다. 이 절은 "누가 어디서 어떻게 끄고 켜는지"를 고정해 재기동 사고를 되풀이하지 않게 한다.

이 절은 **실측 사실**과 **추정**을 섞지 않는다. 대조 시험을 하지 않은 항목은 "추정" 또는 "위험"으로 표시하고, 표시가 없는 문장은 아래 배선 표처럼 읽기 전용으로 확인한 것만 쓴다.

### 배선 사실 (2026-08-04 읽기 전용 실측)

| 항목 | 실측값 |
|---|---|
| 운영 앱 프로세스 | PID 43323, PPID 1, `dist/mac-arm64/Orca Kyle.app/Contents/MacOS/Orca Kyle /Users/fw_m1/Dev/orca-kyle` |
| launchd 등록 | `application.com.chickenbreastky.orca-kyle.<...>` — GUI `open`이 자동 생성한 application job |
| LaunchAgent plist | 없음 (`~/Library/LaunchAgents`에 Orca Kyle 항목 0건) |
| 별도 launchd job | `com.kyle.orca.companion.terminal-daemon-versioned-handoff` (PID 84884) — 앱과 수명이 다르다 |
| 감독 companion | PID 90191, PPID 53075 — 앱 안 터미널의 자식이라 앱이 죽으면 같이 죽는다 |

### 분리 규칙 (세 줄)

1. **launchd 상주와 앱 `open`은 다른 것이다.** 앱을 LaunchAgent plist로 상주시키지 않는다. 자동 재기동이 붙으면 종료 즉시 되살아나 "정말 꺼졌는지"를 판정할 수 없다. 위 companion job처럼 앱과 무관한 데몬만 launchd에 둔다.
2. **기동은 `open` 필수.** `open -n "<절대경로>/Orca Kyle.app"`만 쓰고, `Contents/MacOS/Orca Kyle` 바이너리를 직접 실행하지 않는다. 이건 운영 방침이다.
   - **확인된 사실**: 지금 도는 앱은 PID 43323 / PPID 1이고, `open`으로 뜬 `application.com.chickenbreastky.orca-kyle.*` launchd job이 등록돼 있다(위 배선 표).
   - **추정(미검증)**: 직접 exec하면 그 application job이 만들어지지 않아 GUI 활성화·재연결이 깨질 수 있다. **직접 exec 대조 시험은 하지 않았다** — 재기동 금지 범위 안이라 실행할 수 없었다. 그러니 이건 "그렇게 된다"가 아니라 "그럴 위험이 있어서 안 한다"로 읽는다.
   - 나중에 이 추정을 사실로 승격하려면 재기동이 허용된 판에서 직접 exec 대조 시험을 하고 결과를 이 줄에 적는다.
3. **실행자는 앱 밖에 있어야 한다.** 앱 안 터미널에서 종료를 실행하면 실행자 자신이 1단계에서 먼저 죽고 기동·확인 단계가 통째로 사라진다. 재기동은 외부 셸(외부 감독) 프로세스가 수행한다. 자기 위치 판정은 `env | grep ORCA_PANE_KEY` — 값이 있으면 앱 안이므로 재기동 실행 자격이 없다.

### 절차

0. **사전 확인 (읽기 전용)** — `ps -p <PID> -o pid,ppid,command`로 대상 PID·경로·PPID, `launchctl list | grep orca`로 application job과 별도 데몬 job을 구분, `env | grep ORCA_PANE_KEY`로 실행자가 앱 밖인지 확인한다. 셋 중 하나라도 예상과 다르면 재기동하지 않고 보고한다.
1. **데이터 보존 — 확인 가능한 완료 조건으로 만든다.** "정상 종료했으니 보존됐겠지"는 검증이 아니다. 정상 종료는 보존 **수단**이고, 아래 대조가 보존 **증거**다.
   - **대상 경로**: 포크 userData `/Users/fw_m1/Library/Application Support/Orca Kyle` (그 안의 `orchestration.db`가 카드·Run 원장). 공식 데이터 경로 `Application Support/orca`는 이 절차에서도 계속 **쓰기 금지**이며 대조 대상도 아니다.
   - **종료 전 스냅샷 — 조회는 두 단계다.** 한 명령으로는 안 된다. `task-list`는 Run 목록을 만들지 못하고(주어진 Run 하나의 카드만 돌려준다), `run-list`는 카드를 돌려주지 않는다.
     1. **Run 목록·개수**는 `run-list`로 뽑는다. `id`만 남기고 `objective` 같은 서술 필드는 버린다.

        ```bash
        orca orchestration run-list --json \
          | jq -c '{runIds: [.result.runs[].id] | sort, runCount: (.result.runs | length)}'
        ```

     2. **각 Run의 카드 개수·상태 분포**는 1단계에서 얻은 Run ID마다 따로 실행한다. Run 하나당 한 번이다.

        ```bash
        orca orchestration task-list --run <run_id> --brief --json \
          | jq -c '{runId: .result.runId,
                    taskCount: (.result.tasks | length),
                    statusDist: (.result.tasks | group_by(.status)
                                 | map({key: .[0].status, value: length}) | from_entries)}'
        ```

     - 위 `jq` 투영은 형식 제한을 지키기 위한 것이다. `--brief`를 써도 응답의 `tasks[]`에는 축약된 `spec`이 그대로 들어 있으므로, **원본 JSON을 그대로 저장하거나 붙여넣지 않는다.** 남기는 것은 `runIds`·`runCount`·`runId`·`taskCount`·`statusDist`뿐이다.
     - 실행 검증을 요구할 때는 요약이 아니라 명령 원문과 출력 원문을 evidence 파일로 남기게 명시한다. 요약만 오는 왕복이 3라운드 반복됐다.
   - **재기동 후 대조**: 같은 두 단계를 같은 순서로 다시 돌린다. 합격 조건은 (a) `runIds` 집합과 `runCount`가 같고 (b) 각 `runId`의 `taskCount`와 `statusDist`가 같은 것, 둘 다다.
   - **차이가 나면 완료 금지.** 개수·상태가 어긋나면 재기동을 성공으로 보고하지 않고, 차이 나는 항목만 적어 즉시 상위에 보고한다. 임의 복구·재생성은 하지 않는다.
   - **기록 형식 제한**: 카드 spec 전문, 편지 본문, 사용자 대화 원문은 보고·로그에 옮기지 않는다. 대조에 필요한 건 ID·개수·상태뿐이다.
   - DB 파일을 미리 복사해 두는 방식은 쓰지 않는다 — 열려 있는 SQLite를 파일 복사하면 WAL이 반영되지 않는다.
2. **정상 종료** — `osascript -e 'quit app "Orca Kyle"'`. 종료 확인은 `ps -p <PID>`가 빈 결과일 때만 인정한다.
   - **`kill -9` 금지 이유(일반 위험)**: 강제 종료는 앱에 정리할 틈을 주지 않는다. 열려 있던 SQLite의 WAL이 정상 체크포인트를 못 타고, 앱이 종료 시 하기로 한 정리(임시 파일, 소켓, 자식 프로세스)도 건너뛴다. 그래서 종료는 항상 정상 종료 경로로 한다.
   - **`state_5.sqlite locked(5)`는 이 절차와 별개 사건이다 (2026-08-04 실측).** 아래 사실과 추정을 섞지 않는다.
     - **사실**: `state_5.sqlite`는 Orca userData DB가 아니라 **Codex 상태 DB**(`/Users/fw_m1/.codex/state_5.sqlite`)다. `journal_mode=wal`, `busy_timeout=0`, `integrity_check` 결과 ok. `lsof` 기준 이 파일을 연 프로세스는 codex PID 11051·38719·62021·86379뿐이고, **운영 앱 PID 43323은 이 DB를 열지 않았다.**
     - **추정**: `busy_timeout=0` 상태에서 여러 Codex 프로세스가 동시에 쓰면 대기 없이 즉시 locked(5)를 받는다는 설명이 가장 그럴듯하다. 다만 **실제 locked 로그는 확보하지 못했다.**
     - **따라서 `kill -9`가 locked(5)의 원인이라고 쓰지 않는다.** 운영 앱은 이 DB를 열지도 않으므로 앱 재기동 방식과 이 오류는 인과로 연결되지 않는다. locked(5)가 다시 보이면 Codex 쪽 동시 접근으로 따로 조사한다.
3. **기동** — `open -n "<절대경로>/Orca Kyle.app"`. 성공 판정은 (a) 새 PID가 잡히고 (b) PPID가 1이고 (c) `launchctl list`에 새 `application.com.chickenbreastky.orca-kyle.*` job이 있는 것, 셋 다다.
4. **실패 복구** — 60초 안에 새 PID가 없으면 재시도는 1회만. 두 번째도 실패하면 더 시도하지 않고 데이터를 그대로 둔 채 상위에 보고한다. 이전 앱을 되살리려고 강제 종료된 잔여 프로세스를 임의로 정리하지 않는다.
5. **완료 신호 — 다른 후속 동작보다 먼저 보낸다.**
   - **일반형(운영 기본값)**: 3단계 기동 판정과 1단계 대조가 끝나면, **그 판의 현재 Run에 `worker_done` 편지를 먼저 보낸다.** handle 재해결, 감시 재가동, 정리 같은 후속 동작은 편지를 보낸 **뒤에** 한다. 재기동 직후는 세션이 가장 잘 끊기는 구간이라, 후속 동작을 먼저 하다 끊기면 "재기동은 됐는데 아무도 모르는" 상태가 된다.
   - 편지에 담을 것: 새 PID / 실행 경로 / launchd label / 1단계 대조 결과(Run 목록 동일, 카드 개수·상태 분포 동일). 대조가 어긋났으면 `--outcome failed`로 보낸다.
   - **이번 판 예시(2026-08-04 `roster-followup`)**: 현재 Run은 `run_70f090bfd1f0`이다. 이 판에서 재기동이 허용됐다면 위 편지의 수신 Run이 `run_70f090bfd1f0`이 된다. Run ID는 판마다 다르므로 이 값을 다른 판에 그대로 쓰지 않는다.
   - 편지를 보낸 뒤: **터미널 handle은 재기동으로 바뀐다**(라우팅 메타데이터). `terminal list --worktree <대상> --json`으로 handle을 다시 얻고, 수명주기 판정은 `taskId+dispatchId` 기준으로 한다.

### 금지

- 이 절차를 문서화한 판(2026-08-04 `roster-followup`)에서는 **실제 재기동을 하지 않는다.** PID 43323의 종료·재시작 금지.
- 앱 안 터미널에서의 재기동 실행, 바이너리 직접 exec, `kill -9`, 앱의 LaunchAgent 상주화.
