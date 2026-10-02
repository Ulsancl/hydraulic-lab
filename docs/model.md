# Hydraulic Lab 계산 모형

모형 식별자는 `hydraulic-quasistatic-1`이다. 고정 유량 펌프, 압력 제한 릴리프, 4포트 3위치 방향 밸브, 단일 로드 복동 실린더를 연결한 **준정상 교육용 회로**를 계산한다. 이 문서는 3D 관찰 화면과 Windows 앱이 공유하는 순수 계산 모형의 가정과 수치 계약을 설명한다. 앱의 검증 결과와 배포 상태는 각 버전의 별도 기록을 따른다.

유체는 비압축성이고 누설·관성·배관 및 밸브의 압력 손실을 무시한다. 하중은 이동을 거스르는 수평 시험 부하다. 이동 중 저항력 크기는 지정값 F이고, 정지 중에는 최대 F까지 반력을 제공한다. 중력 때문에 스스로 내려가는 하중이나 실제 굴삭기 붐의 움직임은 이 모형에 포함하지 않는다.

## 단위와 고정 형상

내부 단위는 m·s·Pa·m³/s·N·W·J다. 표시할 때만 mm·mm/s·bar·L/min·kN으로 변환한다. `1 bar=100000 Pa`, `1 L/min=1/60000 m³/s`다. 압력은 탱크를 기준으로 한 게이지압이다.

| `DIMENSIONS_SI` | 값 |
|---|---:|
| `boreM` / `rodDiameterM` | 0.060 / 0.035 m |
| `strokeM` | 0.300 m |
| `pistonThicknessM` | 0.018 m |
| `capDeadLengthM` / `rodDeadLengthM` | 각각 0.006 m |
| `capDeadVolumeM3` | 캡측 면적 × 0.006 m, 약 16.965 mL |
| `rodDeadVolumeM3` | 로드측 환형 면적 × 0.006 m, 약 11.192 mL |
| `tankVolumeAtRetractedM3` | 0.006 m³, 완전 후퇴 시 6 L |

양실의 최소 체적은 실제 형상의 6 mm 끝 공간에서 도출한다. 임의의 숨겨진 추가 공간을 붙이지 않는다. 데드볼륨은 압축성 계산을 의미하지 않는다. 고정된 호스·밸브 공간은 이 가변 체적 수지에서 제외한다.

위치 x=0은 완전 후퇴, x=0.300 m는 완전 전진이다. 보어 D, 로드 직경 d에 대해:

```text
Ac = π D² / 4                 캡측 면적
Ar = π (D² − d²) / 4          로드측 환형 면적
Ad = Ac − Ar                 로드 단면적
Vcap = Ac × 0.006 + Ac x
Vrod = Ar × 0.006 + Ar (0.300 − x)
Vtank = 0.006 − Ad x
```

세 체적의 합은 일정하다. 탱크 체적은 x에서 직접 도출하므로 별도 유량 적분에 의한 부피 드리프트가 없다.

## 설정과 조작

| 설정 | 기본값 | 허용 범위 |
|---|---:|---:|
| `pumpFlowM3s` | 0.0001 m³/s = 6 L/min | 2–12 L/min |
| `reliefPressurePa` | 5,000,000 Pa = 50 bar | 20–100 bar |
| `resistingForceN` | 4,000 N | 0–10,000 N |

명령은 `extend`, `neutral`, `retract` 세 가지다. 전진은 P→A·B→T, 후진은 P→B·A→T, 중립은 P→T이고 A·B는 막히는 탠덤 센터다. 펌프는 양의 지정 유량을 공급한다. 관찰 일시정지는 시간을 멈추는 기능이며 펌프 전원 차단이나 중간 스풀 개구를 해석하는 기능이 아니다.

설정 압력은 압력의 상한이다. 움직이는 동안 필요한 압력은 전진 `F/Ac`, 후진 `F/Ar`로 정해지고, 반환측은 0 Pa다. 속도는 전진 `Q/Ac`, 후진 `−Q/Ar`이며 유압 힘은 항상 부호 있는 `pA·Ac−pB·Ar`로 산출한다.

같은 유량의 후진 속력이 큰 것은 로드가 차지한 면적 때문이다. 6 L/min에서 전진은 약 35.368 mm/s, 후진은 53.610 mm/s다. 전체 300 mm 행정은 각각 약 8.482초, 5.596초 걸린다. 반대측 0 Pa와 공급압 50 bar를 가정한 최대 힘은 전진 약 14.137 kN, 후진 9.327 kN이다. 공급압은 평소 항상 50 bar로 고정되지 않는다.

## 압력 한계와 행정 끝

이동은 남은 행정이 있고 `필요압력 < 상한압력 − 0.01 Pa`일 때만 가능하다. 상한과 정확히 같은 하중에서는 정지를 선택한다. 무관성·이상 릴리프 가정만으로 경계의 속도가 유일하게 정해지지 않으므로 이 선택을 명시했다. 0.01 Pa는 산술 경계 허용값이며 실제 밸브의 히스테리시스가 아니다.

힘이 부족하면 상태는 `pressure-limit`, 바깥쪽 명령으로 행정 끝에 닿으면 `end-stop`이다. 두 경우 모두 속도는 0, 공급측은 상한압력, 펌프 전량은 릴리프로 흐른다. 저항이나 끝 지지가 반력을 담당한다. 끝점에서 반대 명령을 주면 반대 방향의 면적과 하중으로 다시 판단한다.

F=0일 때는 이 무손실·무관성 이상화에서 압력 0으로 지정 속도로 움직인다. 실제 장치의 기동 마찰·관성·손실을 재현한다는 의미가 아니다.

## 포트 유량과 에너지

`capIntoCylinder`, `rodIntoCylinder`는 실린더로 유입할 때 양수이고 배출할 때 음수다. 나머지 유량은 필드명에 적힌 방향이 양수이며 `tankNetInto`는 탱크로 들어가는 순유량이다.

```text
capIntoCylinder = Ac v
rodIntoCylinder = −Ar v
tankNetInto = −Ad v
pumpFromTank = supplyToValve + reliefToTank = Q
tankNetInto = valveToTank + reliefToTank − pumpFromTank
```

중립에서는 실린더 양실 유량이 0이고 `supplyToValve=valveToTank=Q`다. 압력/행정 끝 정지에서는 `supplyToValve=valveToTank=0`, `reliefToTank=Q`다. 전진·후진의 공급 유량과 반환 유량이 같다고 놓지 않는다.

동력과 에너지는 분리한다:

```text
펌프 유압 동력(W) = pP Q
부하에 전달한 동력(W) = F |v|
릴리프 소산 동력(W) = (pP − pT) × reliefToTank
각 구간의 에너지(J) = 그 구간의 동력 × 지속시간
```

이 모형은 `펌프 동력 = 부하 동력 + 릴리프 소산`을 만족한다. 중립의 손실 없는 순환은 세 동력이 모두 0이다. 실제 펌프 기계 손실이나 밸브 순환 손실까지 0이라는 주장이 아니다. 압축성 저장 에너지는 계산하지 않는다. 릴리프 소산을 임의의 오일 온도로 변환하지 않는다.

## 중립과 새 조건의 비교

중립으로 바꾸면 마지막 pA·pB와 위치를 보존하고 pP만 0이 된다. 양실 압력은 `isolated-ideal-hold`이며 누설·탄성 변형·압력 완화를 해석하지 않는 이상 잠금이다. 저장 검증은 같은 위치·설정에서 직전 전진 또는 후진이 실제로 만들 수 있는 압력만 허용한다. 따라서 이동 가능한 중간 위치에 끝점 압력을 임의로 저장하는 상태는 거부한다. 새 실험의 양실 0은 유효하다. 순간적으로 0으로 지우거나 가짜 감압 곡선을 만들지 않는다.

유량·하중·릴리프 설정은 `reconfigureExperiment`로 **같은 위치의 새 실험**을 만든다. 새 설정, 중립, 시간·누적량 0, 초기 양실 게이지압 0으로 시작한다. 위치가 같으므로 양실/탱크 체적도 같다. 이는 실제 감압이나 밸브 조작의 물리 전이가 아니다. 화면에서 입력값을 편집한 뒤 **새 조건 적용**을 눌러야 바뀌며, 이전 실험 상태와 관찰 시점은 되돌리기로 복구할 수 있다.

## API와 상태

- `normalizeSettings(input)`는 잘못된 live 입력을 기본값/범위로 보정한다. 문자열을 숫자로 바꾸지 않는다.
- `createExperiment(settings, {positionM})`는 기본 중간 위치에서 중립 실험을 만든다. 초기 위치만 0..행정 범위로 보정한다.
- `assertValidState(state)`는 값과 수지·압력의 일관성을 검사하고 원 상태를 반환한다. 잘못된 값은 `TypeError`/`RangeError`이며 보정하지 않는다. 실험 파일 codec이 이 strict 검사를 사용한다.
- `setCommand(state, command)`는 시간·누적 에너지를 바꾸지 않고 이상 정상상태로 전환한다.
- `reconfigureExperiment(state, patch)`는 위의 명시적 새 비교 실험이다.
- `instantSnapshot(state)`는 위치·속도·상태·압력·유량·체적·동력·유로를 반환한다.
- `step(state, dtSeconds)`는 `{state, interval}`을 반환한다. 입력과 출력은 서로 변경 가능한 객체를 공유하지 않는다.

State는 `modelVersion`, `settings`, `command`, `positionM`, `timeS`, `pressureAPa`, `pressureBPa`, `energyJ:{pump,load,relief}`, `cumulativeVolumeM3:{pump,relief}`를 갖는다. 누적량의 기록은 과거 모든 조작 이력을 증명하는 것이 아니라 현재 파일의 내부 일관성을 검사한다.

시간 간격은 유한한 0..3,600초, 누적 시뮬레이션 시간은 0..1,000,000,000초다. 허용 범위를 벗어나면 상태를 부분 변경하지 않고 거부한다. 0초는 아무것도 진행하지 않는다.

## 부분 프레임과 검증

명령·설정이 고정되면 속도도 일정하다. `step`은 미세 적분 대신 끝점까지 남은 시간 `거리/속력`을 계산한다. 한 호출에서 이동 구간과 행정 끝 정지 구간으로 최대 두 번 나누고, 각각의 시간에 해당 압력·유량·동력을 적용한다. 정확히 끝점에 도착한 호출에는 릴리프 시간이 0이므로 릴리프 에너지도 0이다. 최종 snapshot은 이미 정지 상태이지만 이 최종 동력을 전체 프레임에 곱하지 않는다.

Interval은 `durationS`, `segments`, `deltaEnergyJ`, `deltaVolumeM3`를 제공한다. 각 구간에는 시작/끝 위치·지속시간·상태·압력·유량·동력이 있다. `deltaVolumeM3.tankNetInto`는 최종과 시작 탱크 체적의 차이다.

검사는 독립 원 면적식, 알려진 속도·힘·행정 시간, 세 밸브 위치의 포트 수지, 압력 경계, 끝점 도달 전/정확한 도달/도달 후의 에너지, 중립 격리, 새 비교 실험, 불규칙 시간 분할 및 1,000회 전행정 왕복 방향 전환을 다룬다. 입력 변이·공유 상태·잘못된 파일 값도 검사한다. 보존량 비교는 부동소수점 오차를 허용하며 완전히 동일한 실수 연산 순서를 요구하지 않는다.

일반 힘·유량 관계는 [Parker의 실린더 응용 자료](https://www.parker.com/content/dam/Parker-com/Literature/Industrial-Cylinder/cylinder/cat/english/Parker_Mobile_Cylinder_Products_Catalog_HY18-1000.pdf), 릴리프와 실제 압력 상승의 구분은 [HydraForce 교육서](https://www.hydraforce.com/globalassets/forms/proportional-manual.pdf)를 참고했다. 대표 치수·경계 정책·코드는 자체 작성했으며 제조사 형상·도표를 포함하지 않는다.

이 계산은 실제 장비의 회로 설계 승인·부하 유지 안전성·정비 판정·열 및 수명 예측을 제공하지 않는다. 관성·압축성·누설·마찰·중력 하중·캐비테이션·실제 릴리프의 유량 특성은 별도 모델이 필요한 확장이다.

## 부품별 상세 관측값

`hydraulicDetail(state, snapshot = instantSnapshot(state))`는 기존 준정상 작동점에서 SI 관측값을 만든다. 원본 상태를 엄격히 검증하며, 잘못된 상태를 기본값으로 바꾸지 않는다. snapshot을 직접 전달하면 같은 state의 `instantSnapshot(state)` 결과여야 한다. `describeHydraulicDetail(partId, state, snapshot)`는 34개 부품에 대해 최대 6개 숫자·단위 행과 해석 문구를 반환한다. 상태·snapshot·설정·누적 에너지를 수정하지 않고, 원본과 공유되는 가변 객체를 반환하지 않는다. 기존 모형 식별자와 저장 형식은 유지한다.

### 실제 압력의 힘과 방향별 한계

```text
capN          = +pA Ac               A 압력의 전진 방향 기여
rodN          = −pB Ar               B 압력의 후진 방향 기여
netHydraulicN = capN + rodN          실제 순유압력
extendLimitN  = 설정 압력 한계 × Ac  반대측 0 Pa에서의 전진 힘 한계
retractLimitN = 설정 압력 한계 × Ar  반대측 0 Pa에서의 후진 힘 한계
```

힘 한계는 크기이며 현재 압력을 사용한 힘과 구분한다. `commandLimitN`은 현재 전진·후진 명령의 한계이고 중립에서는 null이다. `requiredPressurePa`, `pressureMarginPa = 한계 − 필요압력`도 중립에서는 null이다. 압력 여유가 양수여도 행정 끝에서는 이동하지 않는다. 이동/정지 판단은 기존 `snapshot.status`를 그대로 사용한다.

설정 저항력 F는 이동 중에는 운동을 거스르는 힘의 크기, 정지 중에는 시험 저항이 제공할 수 있는 반력의 상한이다. 중립에 고정 방향의 F를 새로 적용하지 않는다. 행정 끝에서는 끝 지지가 추가 반력을 제공할 수 있다. 따라서 부품 관측값은 임의로 외부 하중 분배·씰 마찰·국부 접촉력이나 가속도를 만들지 않는다.

`retractToExtendSpeedRatio = Ac/Ar`는 같은 공급 유량으로 **양방향 모두 이동 가능할 때**의 후진/전진 속력비다. 중립이나 막힘 상태의 0/0 속도 비율이 아니다. 현재 속도는 원래 작동점 값을 사용한다.

### 체적 변화와 남은 이동

각 액실의 `volumeRateM3s`는 해당 액실로 유입할 때 양수다. 캡측은 `Ac v`, 로드측은 `−Ar v`, 탱크의 변화율은 `−(Ac−Ar)v`다. 액실 체적은 6 mm 끝 공간을 포함한 기존 `volumesM3`이며 임의로 별도 공간을 더하지 않는다.

`status === 'moving'`인 경우에만 `distanceToStopM`과 `timeToStopS`를 계산한다. 전진의 남은 거리는 `행정−x`, 후진은 `x`, 시간은 `남은 거리/|v|`다. 중립·압력 제한·행정 끝에서는 두 값이 null이며 화면에는 ‘이동 중 아님’을 표시한다. 도달 예상은 현재 명령·조건을 유지할 때의 **모형 시간**이다. 관찰 일시정지나 재생 배율은 작동점의 압력·유량·속도를 바꾸지 않는다.

### 분기와 합류 유량

P 배관의 분기 전에는 `pumpFromTank`, 방향밸브 P 포트에는 `supplyToValve`, 릴리프 가지에는 `reliefToTank`가 흐른다. 막힘이나 행정 끝에서는 첫 번째는 Q이지만 방향밸브 P 유입은 0이다. 반대로 중립에서는 P→T 경로로 Q가 순환한다.

방향밸브 T 포트의 유량은 `valveToTank`다. 릴리프 유량은 T 포트 바깥에서 합류하므로 공통 복귀관·필터·탱크 복귀 유량은 `returnCombinedM3s = valveToTank + reliefToTank`다. 탱크의 순유입은 합류 복귀 유량에서 펌프 흡입 Q를 뺀 값이다. 공급·반환 유량의 차이를 손실이나 누설로 해석하지 않는다. 단일 로드의 체적 변위에 따른 차이다.

### 동력·에너지·잔압

액실로 들어가는 부호 있는 유압 동력은 `pA × capIntoCylinder`, `pB × rodIntoCylinder`다. 그 합은 `(pA Ac − pB Ar) v`와 같으며, 기존 저항 부하 전달 동력 `F|v|`와 일치한다. 이는 압축 에너지 저장이나 개별 부품 발열 계산이 아니다.

중립에서는 잔압과 순유압력이 남을 수 있어도 양실 유량·실린더 동력은 0이다. P→T 순환의 이상 펌프 동력도 0이다. 잔압을 지우거나 이를 가상의 압축 저장 에너지로 바꾸지 않는다. 릴리프 소산은 W와 누적 J로 읽고, 열용량을 임의로 가정해 오일 온도로 환산하지 않는다.

`power.loadShare`는 펌프 유압 동력이 양수인 경우에만 `부하 유압 동력/펌프 유압 동력`을 반환한다. 중립과 무부하 이동의 0/0에서는 null이다. 이 비율은 모델 내부 동력 배분이며 실제 펌프·시스템 효율이 아니다.

### 수지 잔차

상세 API는 다음 값을 숨기거나 0으로 강제하지 않고 원래 숫자로 반환한다.

```text
volumeResidualM3       = Vcap + Vrod + Vtank − 기준 총 유체 체적
rateResidualM3s        = Qcap + Qrod + Qtank,net
pumpBranchResidualM3s  = Qpump − Qvalve,in − Qrelief
tankResidualM3s        = Qtank,net − (Qvalve,out + Qrelief − Qpump)
cylinderPowerResidualW = pA Qcap + pB Qrod − 순유압력 × v
power.residualW        = 펌프 동력 − 부하 동력 − 릴리프 소산
energyResidualJ        = 누적 펌프 일 − 누적 부하 일 − 누적 릴리프 소산
```

행정 끝을 가로지른 시간 구간의 누적 에너지는 기존 구간 적분을 사용한다. 마지막 순간의 릴리프 동력을 구간 전체에 곱해 누적값을 다시 만들지 않는다. 새 조건 적용은 기존 규칙대로 같은 위치의 새 실험이며, 상세 관측 자체는 그 전환을 수행하지 않는다.

추가 검증 `tests/detail-model.test.mjs`는 실제 시간 진행에 따른 액실·탱크 체적 차분, 동일 공급 체적의 양방향 변위·복귀 유량 차이, 끝점 도달 시간, 끝점 전후의 독립적인 `F×이동거리`·`상한압력×릴리프 체적`, 잔압 중립, 압력 경계, 0 부하, 입력 범위 양끝, 모든 부품의 표시 단위와 비변경성을 검사한다.
