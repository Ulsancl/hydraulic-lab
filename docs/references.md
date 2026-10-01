# 참고 자료와 자체 모형의 범위

공식 자료의 기본 원리를 참고해 자체 대표 회로와 형상을 제작했습니다. 제조사 사진·CAD·교재 도표·상표는 앱 자산에 포함하지 않았습니다. 자료 확인일은 2026-10-01입니다.

- [Parker — Mobile Cylinder Products and Application Guide, HY18-1000](https://www.parker.com/content/dam/Parker-com/Literature/Industrial-Cylinder/cylinder/cat/english/Parker_Mobile_Cylinder_Products_Catalog_HY18-1000.pdf): 실린더의 유효 면적, 압력과 힘, 유량과 속도의 기본 관계를 참고했습니다. 제품 치수나 텔레스코픽 실린더의 구조를 재현한 앱은 아닙니다.
- [Bosch Rexroth — Hydraulic training systems](https://www.boschrexroth.com/en/nz/c/training-systems-for-hydraulics/): 기본 회로와 압력차·유량을 실험으로 관찰하는 교육 구성을 참고했습니다. 이 앱의 세 실험과 화면 구성은 자체 설계입니다.
- [HydraForce — Electro-Hydraulic Proportional Valves Manual](https://www.hydraforce.com/globalassets/forms/proportional-manual.pdf): Chapter 3, 인쇄 20–21쪽의 릴리프 개방 시작 압력과 유량에 따른 압력 상승 설명을 참고했습니다. 실제 밸브는 유량과 부품 특성에 따라 설정값 이상의 압력이 필요할 수 있습니다. 앱은 이를 이상적인 일정 압력 한계로 단순화합니다.

60 mm 보어·35 mm 로드·300 mm 행정, 6 mm 끝 공간, 18 mm 피스톤과 스풀의 홈·통로 치수는 앱의 자체 예제입니다. 수평 저항 부하, 비압축성, 누설·관성·압력 손실 없음, 압력 한계와 같은 조건에서 정지하는 정책도 자체 모형의 가정입니다. [모형 문서](model.md)와 [형상 문서](anatomy.md)에 구체적인 의미를 기록했습니다.

3D 부품과 회로 그림은 구조를 관찰하고 조건을 비교하는 데 쓰입니다. 실제 제품의 성능 보증이나 설계·정비 절차로 사용하도록 제작하지 않았습니다.
