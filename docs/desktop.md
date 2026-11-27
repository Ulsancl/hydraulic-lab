# Windows 설치와 사용

## 일반 사용자 설치

Windows x64용 `Hydraulic-Lab-Setup-<버전>.exe`를 실행해 설치 위치를 선택한다. 기본 위치는 `%LOCALAPPDATA%\Programs\Hydraulic Lab`이다. 설치 후 바탕화면 또는 시작 메뉴의 **Hydraulic Lab**으로 실행한다. 앱에 Electron 실행 환경·모형·3D 자산이 들어 있으므로 Node.js·서버·인터넷을 별도로 준비하지 않는다. 그래픽 환경은 WebGL2를 지원해야 한다. 검증한 Windows·GPU·화면 배율과 검사 결과는 각 릴리스 기록에 명시한다.

정식 배포 파일은 Windows Authenticode 서명과 게시자를 확인한다. 일반 개발·CI 설치파일은 미서명이므로 Windows 게시자·평판 경고가 표시될 수 있다. 내려받은 파일이 제공된 파일과 같은지 확인하려면 `Get-FileHash -Algorithm SHA256 -LiteralPath '.\Hydraulic-Lab-Setup-<버전>.exe'`의 결과를 `.sha256` 값과 비교한다.

자동 업데이트는 없다. 먼저 실험을 JSON에 저장하고 앱을 닫은 뒤 새 설치파일을 실행한다. 앱 저장 폴더는 유지하도록 구성되어 있으나 중요한 관찰은 별도 파일로 보관한다. 이전 앱은 더 새로운 저장 형식을 열지 못할 수 있으므로 업데이트 전 파일도 보관한다. 앱의 버전은 **도움말 → 프로그램 정보**에서 확인한다.

제거는 **Windows 설정 → 앱 → 설치된 앱 → Hydraulic Lab**에서 수행한다. 일반 제거는 앱 저장 폴더와 사용자가 저장한 JSON을 유지한다. 저장 위치·완전한 데이터 제거는 [개인정보와 저장 위치](privacy.md), 실행·파일 문제는 [문제 해결](support.md)을 참고한다.

## 소스 실행과 패키징

제품 이름은 `Hydraulic Lab`, AppUserModelId/설치 식별자는 `com.hydrauliclab.app`, 저장 폴더는 `%APPDATA%\Hydraulic Lab`, 지속 origin은 `app://hydraulic/`이다. Engine Lab·Brake Lab의 저장소나 origin을 사용하지 않는다. 개발 웹 서버는 Vite 설정의 5199 포트이며 설치 앱에는 서버가 필요 없다.

Node.js 24.19에서 `npm ci --ignore-scripts`로 고정 의존성을 설치한다. `npm run desktop`은 Electron 런타임 준비와 빌드 후 앱을 시작한다. `npm run package:desktop`은 미서명 Windows x64 NSIS 설치파일 `release/windows/Hydraulic-Lab-Setup-<package.json 버전>.exe`와 SHA-256 파일을 만든다. Python/Pillow는 자체 아이콘 제작에만 필요하다.

정식 배포 담당자는 승인된 Windows 서명 환경에서 electron-builder에 실제 코드 서명 자격 증명을 제공하고 신뢰 경로에서 확인한 인증서 지문을 `HYDRAULIC_SIGNER_THUMBPRINT`로 지정한 뒤 `node scripts/desktop.mjs package-release`를 실행한다. 이 명령은 서명을 강제하며 앱 EXE와 설치파일의 Authenticode 상태가 각각 `Valid`이고 게시자 인증서 지문이 일치할 때만 결과를 게시한다. 일반 PR·브랜치 검증에는 서명 자격 증명이 필요 없다.

## Renderer 계약

preload는 `hydraulicDesktop`만 노출한다.

- `isDesktop: true`
- `openProject()` → `{canceled:true}` 또는 `{canceled:false,project}`
- `saveProject({contents,name})` → `{canceled:true}` 또는 `{canceled:false}`
- `setBusy(boolean)`
- `onCommand(callback)` → listener를 제거하는 함수

메뉴 명령은 `new-project`, `open-project`, `save-project`, `toggle-running`, `focus`, `help`다. Node.js 객체나 범용 파일 API는 노출하지 않는다. `contextIsolation`, renderer sandbox, `webSecurity`를 켜고 Node 통합은 끈다. 로컬 앱과 같은 출처의 blob만 허용하고 외부 이동·하위 프레임 이동·팝업·권한 요청을 차단한다. 원문 복구 다운로드는 앱 출처의 JSON 또는 텍스트로 제한한다.

main은 `src/project.js`에서 프로젝트 크기·구조·물리 정합성을 한 번 검증하고 검증한 객체만 renderer에 전달한다. renderer는 현재 state·view·camera를 한 번에 바꾸며, 실패 시 현재 관찰·자동 저장 원문을 유지한다.

열기 작업은 실제 부모와 열린 핸들의 일반 파일을 확인하고 10 MiB + 1바이트까지만 읽는다. 창 설정은 4 KiB를 초과하거나 일반 파일이 아니면 기본값을 사용한다. Windows 저장은 쓰기 전 현재 사용자로 임시 파일 접근을 제한한다. 덮어쓸 때는 Windows의 파일 교체 API가 기존 DACL을 보존하며, 복원이 필요한 오류에 대비해 원본 백업을 사용한다. 권한을 보존할 수 없는 저장 위치에서는 다른 파일 이름을 선택할 수 있다.

작업 중 닫기 요청은 유지/종료 선택을 표시한다. 정상 닫기는 실제 normal bounds를 보관하고 다음 실행에서 화면 범위에 맞춘다. Windows 소수 배율의 최대 2 DIP 반올림 오차는 3회 이내 보정하여 반복 복원 시 창이 커지는 현상을 방지한다.

## 합성 프로필 검사

`npm run test:desktop`은 소스 Electron과 새 합성 프로필을 사용한다. `node scripts/desktop.mjs package-test`로 만든 검사 전용 EXE는 `HYDRAULIC_DESKTOP_EXE`로 지정한다. `HYDRAULIC_LAB_DATA_DIR`는 소스와 검사 전용 패키지에서 절대 경로만 받는다. 검사 시 앱 identity와 실제 userData 경로를 대조한다.

`window.hydraulicLab` 검사 hook과 Playwright의 main-process 검사 기능은 검사 빌드에서만 사용한다. 주요 검사는 격리 실행·오프라인 번들, 메뉴/명령·단일 step, native 파일 취소/오류/왕복 보존, 도움말/About, 파일 작업 중 닫기, 창 위치·크기 반복 복원이다. CI는 별도로 일반 패키지 EXE의 Fuse 값, 실행, UI 조작 및 검사 hook 부재를 확인한다.

GitHub Actions는 고정 Node·의존성으로 순수 검사, 웹 빌드, 브라우저와 학습 안내 검사, 소스 앱 검사, NSIS 패키징, 독립 패키지 EXE 검사, 체크섬·고지 검사를 순서대로 실행한다. 통과한 설치파일과 진단 자료를 CI artifact로 보관하며 GitHub Release는 자동 게시하지 않는다. CI 패키지 실행은 실제 사용자 PC의 설치·바로가기·업데이트 검증을 대체하지 않는다. 공개에 필요한 전체 확인 항목은 [공개 완료 기준](release-scope.md)을 따른다.
