# Orca Kyle 유지보수 절차

## Why

공식 Orca는 하루에도 여러 번 배포된다. 포크가 `main`을 따라가면 매번 새 변경을 떠안고, 멈춰 있으면 보안·provider·OS 수정을 놓친다. 이 문서는 두 수정(#11737/#11745)이 포함된 안정 기준선 위에서 필요한 변경만 선별 반영하는 절차를 고정한다.

## 기준선

- 현재 기준선: `d34bbd7917b3afde4c164ee7338dae4bf1e5818a` + 포크 패치 스택
- 장기 기준선: #11737(`9a267602...`)과 #11745(`d34bbd79...`)를 모두 조상으로 포함하는 첫 안정 태그
- 안정 태그의 조건: SemVer suffix 없음, GitHub release가 `draft=false`·`prerelease=false`, 두 fix SHA를 조상으로 포함, exact tag SHA 기록

## 반영 절차

1. `git fetch upstream --tags` 후 새 안정 태그를 찾는다.
2. 태그가 두 fix SHA를 조상으로 포함하는지 `git merge-base --is-ancestor`로 확인한다. 없으면 기준선 이동 금지.
3. 새 기준선 전환은 `새 stable base → 포크 identity/isolation/updater 패치 스택 순차 replay(-x) → copied-profile schema gate → 최종 검증` 순서로만 한다.
4. 패치 채택은 한 커밋/한 주제 단위 `git cherry-pick -x`다. 전체 자동 병합은 금지한다.
5. 어느 단계든 실패하면 기존 기준선 SHA를 유지한다.

## 추적 대상

- provider/OS/보안/PTY/SSH/orchestration/updater 관련 커밋만 후보로 분류한다.
- 공식 updater를 복원하는 패치는 자동 거절한다(포크는 수동 로컬 빌드 전용).
- prerelease/draft 태그, 두 fix 미포함 태그, replay 실패는 점검에서 구분해 기록한다.

## 금지

- upstream `main` 자동 병합, 전체 동기화, 무검토 의존성 갱신
- 포크 `main`에 직접 커밋, RC를 일상 기준점으로 승격
- 공식 `latest` 채널/태그 흉내
