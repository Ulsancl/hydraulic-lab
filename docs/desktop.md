# Windows 설치와 사용

## 일반 사용자 설치

Windows x64용 `Hydraulic-Lab-Setup-<버전>.exe`를 실행해 설치 위치를 선택한다. 기본 위치는 `%LOCALAPPDATA%\Programs\Hydraulic Lab`이다. 설치 후 바탕화면 또는 시작 메뉴의 **Hydraulic Lab**으로 실행한다. 앱에 Electron 실행 환경·모형·3D 자산이 들어 있으므로 Node.js·서버·인터넷을 별도로 준비하지 않는다. 그래픽 환경은 WebGL2를 지원해야 한다. 검증한 Windows·GPU·화면 배율과 검사 결과는 각 릴리스 기록에 명시한다.

앱과 설치파일에는 코드 서명이 없어 Windows 게시자·평판 경고가 표시될 수 있다. 배포 출처와 제공된 `.sha256` 파일을 확인하고, PowerShell에서 설치파일의 실제 값을 확인하려면 `Get-FileHash -Algorithm SHA256 -LiteralPath '.\Hydraulic-Lab-Setup-<버전>.exe'`를 사용한다. 꺾쇠 안의 버전은 받은 파일명으로 바꾼다. 해시는 다운로드한 파일이 제공된 파일과 같은지를 확인하는 수단이다.

자동 업데이트는 없다. 먼저 실험을 JSON에 저장하고 앱을 닫은 뒤 새 설치파일을 실행한다. 앱 저장 폴더는 유지하도록 구성되어 있으나 중요한 관찰은 별도 파일로 보관한다. 이전 앱은 더 새로운 저장 형식을 열지 못할 수 있으므로 업데이트 전 파일도 보관한다. 앱의 버전은 **도움말 → 프로그램 정보**에서 확인한다.

제거는 **Windows 설정 → 앱 → 설치된 앱 → Hydraulic Lab**에서 수행한다. 일반 제거는 앱 저장 폴더와 사용자가 저장한 JSON을 유지한다. 저장 위치·완전한 데이터 제거는 [개인정보와 저장 위치](privacy.md), 실행·파일 문제는 [문제 해결](support.md)을 참고한다.

## 소스 실행과 패키징

제품 이름은 `Hydraulic Lab`, AppUserModelId/설치 식별자는 `com.hydrauliclab.app`, 저장 폴더는 `%APPDATA%\Hydraulic Lab`, 지속 origin은 `app://hydraulic/`이다. Engine Lab·Brake Lab의 저장소나 origin을 사용하지 않는다. 개발 웹 서버는 Vite 설정의 5199 포트이며 설치 앱에는 서버가 필요 없다.

Node.js 24.19에서 `npm ci`로 고정 의존성을 설치한다. `npm run desktop`은 Electron 런타임 준비와 빌드 후 앱을 시작한다. `node scripts/desktop.mjs prepare-test`는 런타임·번들만 준비하고 창을 열지 않는다. `npm run package:desktop`은 Windows x64 NSIS 설치파일 `release/windows/Hydraulic-Lab-Setup-<package.json 버전>.exe`와 SHA-256 파일을 만든다. 자동 게시·자동 업데이트·코드 서명을 구성하지 않는다. Python/Pillow는 자체 아이콘을 새로 만드는 선택적 제작 도구이며 실행·패키징에는 필요하지 않다.

## Renderer 계약

preload는 `hydraulicDesktop`만 노출한다.

- `isDesktop: true`
- `openProject()` → `{canceled:true}` 또는 `{canceled:false,content,path}`
- `saveProject({contents,name})` → `{canceled:true}` 또는 `{canceled:false,path}`
- `setBusy(boolean)`
- `onCommand(callback)` → listener를 제거하는 함수

메뉴 명령은 `new-project`, `open-project`, `save-project`, `toggle-running`, `focus`, `help`다. Node.js 객체나 범용 파일 API는 노출하지 않는다. `contextIsolation`, renderer sandbox, `webSecurity`를 켜고 Node 통합은 끈다. 로컬 번들만 제공하며 HTTP(S) 요청·외부 페이지 이동·팝업·권한 요청을 차단한다.

원시 JSON의 크기와 구조뿐 아니라 `src/project.js`의 동일 codec으로 저장·열기를 검증한다. main에서도 사용하는 `src/project.js`·`src/model.js`는 패키지에 포함한다. renderer는 반환된 내용을 다시 전체 검증한 뒤 현재 state·view·camera를 한 번에 바꾸며, 실패 시 현재 관찰·자동 저장 원문을 유지해야 한다. 새 형식 원문을 일반 파일로 덮어쓰지 않는다.

읽기는 일반 파일과 실제 부모 폴더를 확인하며 디렉터리·심볼릭 링크·연결 폴더를 거부한다. 크기 제한은 10 MiB다. 저장은 선택한 폴더의 배타적 임시 파일을 기록·동기화한 다음 rename으로 교체하며, 기존 파일을 먼저 삭제하지 않는다. 실패 시 이 작업에서 만든 임시 파일만 정리한다.

작업 중 닫기 요청은 유지/종료 선택을 표시한다. 정상 닫기는 실제 normal bounds를 보관하고 다음 실행에서 화면 범위에 맞춘다. Windows 소수 배율의 최대 2 DIP 반올림 오차는 3회 이내 보정하여 반복 복원 시 창이 커지는 현상을 방지한다.

## 합성 프로필 검사

`HYDRAULIC_LAB_DATA_DIR`는 절대 경로만 받는다. native harness는 workspace의 `output/desktop[-packaged]-v<버전>/profile-*`에 새 합성 프로필을 만들며 실제 사용자 프로필이나 사용 중인 앱을 수정·종료하지 않는다. `HYDRAULIC_DESKTOP_EXE`를 지정하면 해당 EXE를 검사하고, 생략하면 source Electron을 검사한다. CI는 패키지의 `win-unpacked` EXE를 지정하고, 실제 설치 검사는 설치 폴더의 EXE를 지정한다. 검사 시 앱 identity와 실제 userData 경로를 대조한다.

`window.hydraulicLab` 검사 hook은 `getState`, `project`, `loadProject`, `step`, `camera`, `components`, `sceneDebug`를 제공한다. 주요 검사는 격리 실행·오프라인 번들, 메뉴/명령·단일 step, native 파일 취소/오류/왕복 보존, 도움말/About, 파일 작업 중 닫기, 창 위치·크기 반복 복원이다. 실제 실행은 다른 GPU 작업과 겹치지 않게 직렬 진행한다.

GitHub Actions는 고정 Node·의존성으로 순수 검사, 웹 빌드, 브라우저와 학습 안내 검사, 소스 앱 검사, NSIS 패키징, 독립 패키지 EXE 검사, 체크섬·고지 검사를 순서대로 실행한다. 통과한 설치파일과 진단 자료를 CI artifact로 보관하며 GitHub Release는 자동 게시하지 않는다. CI 패키지 실행은 실제 사용자 PC의 설치·바로가기·업데이트 검증을 대체하지 않는다. 공개에 필요한 전체 확인 항목은 [공개 완료 기준](release-scope.md)을 따른다.
