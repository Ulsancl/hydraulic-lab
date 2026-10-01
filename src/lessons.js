// Starting conditions and visible actions for the guided observations. Inputs are SI.
export const LESSONS = Object.freeze([
  Object.freeze({
    id: 'speed-ratio', title: '같은 유량, 다른 속도',
    question: '같은 양의 오일을 보내도 후진이 더 빠른 이유는 무엇일까요?',
    settings: Object.freeze({ pumpFlowM3s: 0.0001, reliefPressurePa: 5000000, resistingForceN: 4000 }),
    positionM: 0, initialCommand: 'extend',
    instructions: Object.freeze(['전진을 재생해 300 mm 행정 끝까지 이동합니다.', '후진으로 바꾸어 0 mm까지 이동하고 두 속력을 비교합니다.']),
  }),
  Object.freeze({
    id: 'pressure-limit', title: '속도와 힘의 한계',
    question: '같은 실린더가 전진할 수 있는데 후진하지 못할 수도 있을까요?',
    settings: Object.freeze({ pumpFlowM3s: 0.0001, reliefPressurePa: 2000000, resistingForceN: 4000 }),
    positionM: 0.15, initialCommand: 'retract',
    instructions: Object.freeze(['20 bar 후진을 재생해 정지와 릴리프 우회를 확인합니다.', '전진을 선택하고 실제로 움직이는지 확인합니다.', '50 bar 새 조건을 적용한 뒤 후진을 재생해 힘의 한계를 비교합니다.']),
  }),
  Object.freeze({
    id: 'neutral-hold', title: '움직임이 멈춘 뒤의 압력',
    question: '중립으로 바꾸면 펌프 쪽과 실린더 쪽 압력이 모두 사라질까요?',
    settings: Object.freeze({ pumpFlowM3s: 0.0001, reliefPressurePa: 5000000, resistingForceN: 4000 }),
    positionM: 0.15, initialCommand: 'extend',
    instructions: Object.freeze(['전진을 잠깐 재생해 이동과 A측 압력을 확인합니다.', '중립을 선택해 A·B 액실을 고립시킵니다.', '중립을 재생해 P→T 순환과 위치·양실 압력 보존을 확인합니다.']),
  }),
]);
