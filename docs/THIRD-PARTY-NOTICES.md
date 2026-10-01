# 외부 소프트웨어 고지

Hydraulic Lab은 Three.js **0.180.0**과 Three.js 예제 모듈을 사용합니다. MIT 라이선스 전문은 소스의 `public/THREE-LICENSE.txt`, 웹 빌드의 `dist/THREE-LICENSE.txt`, Windows 설치 폴더의 `resources/THREE-LICENSE.txt`에 포함합니다. 외부 구성요소를 재배포할 때 해당 고지를 유지해야 합니다.

Windows 앱에는 Electron **44.5.1**과 그 안의 Chromium·Node.js 및 관련 구성요소가 포함됩니다. 설치 폴더의 `LICENSE.electron.txt`와 `LICENSES.chromium.html`은 Electron 및 포함 구성요소의 고지입니다. 이 파일들도 앱과 함께 유지합니다. 정확한 의존성 버전은 `package-lock.json`에 고정합니다.

Vite **7.3.6**, Playwright **1.63.0**, electron-builder **26.15.3**은 개발·빌드·검사 도구입니다. 이 도구의 개발 패키지는 Windows 앱에 포함하지 않습니다. 생성된 웹 JavaScript와 Electron 실행 환경은 포함합니다.

유압 부품·배관·회로 그림은 앱 코드로 만든 대표 형상입니다. 제조사의 CAD·사진·도표·상표나 외부 폰트·HDR 파일은 앱 자산으로 배포하지 않습니다. [참고 자료](references.md)는 모형 원리를 설명하기 위한 링크이며 해당 자료를 복제하거나 제조사의 검증·보증을 주장하지 않습니다.

아이콘은 `scripts/create-icon.py`의 자체 도형으로 생성합니다. 이 선택적 제작 도구는 Pillow를 사용하며, 앱에는 생성된 PNG·ICO만 포함합니다. Python·Pillow는 앱 실행이나 설치에 필요하지 않습니다.

이 문서는 외부 구성요소에 관한 고지이며 앱 전체에 MIT 등 소스 사용 허가를 부여하지 않습니다. 앱 자체는 **UNLICENSED / All rights reserved**입니다. 소스의 `LICENSE.txt`, 설치 폴더의 `resources/LICENSE.txt`를 확인하세요. 판매·재배포·상표·지원 조건은 제품 소유자가 별도로 정합니다.

배포 후보마다 위 고지와 `resources/docs`, `resources/사용 안내.txt`가 설치 결과에 포함되어 있는지 확인합니다. 고지 포함 검사와 기능·사용성 검사는 별개입니다.
