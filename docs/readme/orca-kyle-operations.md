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
