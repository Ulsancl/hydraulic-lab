import { DIMENSIONS_SI } from './model.js';

const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const capArea = Math.PI * DIMENSIONS_SI.boreM ** 2 / 4;
const rodArea = Math.PI * (DIMENSIONS_SI.boreM ** 2 - DIMENSIONS_SI.rodDiameterM ** 2) / 4;
const capDeadLength = DIMENSIONS_SI.capDeadVolumeM3 / capArea;
const rodDeadLength = DIMENSIONS_SI.rodDeadVolumeM3 / rodArea;
const capInsideX = -.280;
const pistonStartX = capInsideX + capDeadLength + DIMENSIONS_SI.pistonThicknessM / 2;
const glandInsideX = pistonStartX + DIMENSIONS_SI.strokeM + DIMENSIONS_SI.pistonThicknessM / 2 + rodDeadLength;

export const GEOMETRY_SI = freeze({
  cylinderAxisY: .235, cylinderAxisZ: 0,
  capInsideX, glandInsideX, pistonStartX, pistonThicknessM: DIMENSIONS_SI.pistonThicknessM,
  capDeadLengthM: capDeadLength, rodDeadLengthM: rodDeadLength,
  boreRadiusM: DIMENSIONS_SI.boreM / 2, barrelOuterRadiusM: .036,
  rodRadiusM: DIMENSIONS_SI.rodDiameterM / 2, rodEndAtRetractedX: .160,
  barrelX: [capInsideX, glandInsideX], capX: [capInsideX - .020, capInsideX], glandX: [glandInsideX, glandInsideX + .022],
  valveCenter: [-.130, .135, .130], valveBodyHalfLengthM: .080,
  tankInsideBounds: { min: [-.510, .020, .040], max: [-.290, .170, .280] },
  pumpCenter: [-.360, .115, -.100], reliefCenter: [-.235, .165, .025], filterCenter: [.045, .100, .200],
});

function bounded(value, name, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new RangeError(`${name} must be finite in [${min}, ${max}]`);
  return value;
}
const cylinderPoint = x => [x, GEOMETRY_SI.cylinderAxisY, GEOMETRY_SI.cylinderAxisZ];
function fluidSection(minX, maxX, innerRadiusM, outerRadiusM) {
  const lengthM = maxX - minX;
  return {
    minX, maxX, lengthM, innerRadiusM, outerRadiusM,
    center: cylinderPoint((minX + maxX) / 2),
    bounds: { min: [minX, GEOMETRY_SI.cylinderAxisY - outerRadiusM, -outerRadiusM], max: [maxX, GEOMETRY_SI.cylinderAxisY + outerRadiusM, outerRadiusM] },
    volumeM3: Math.PI * (outerRadiusM ** 2 - innerRadiusM ** 2) * lengthM,
  };
}

/** SI geometry only; pressure, velocity, and force remain model responsibilities. */
export function cylinderGeometry(positionM) {
  bounded(positionM, 'positionM', 0, DIMENSIONS_SI.strokeM);
  const centerX = pistonStartX + positionM, halfThickness = DIMENSIONS_SI.pistonThicknessM / 2;
  const pistonMinX = centerX - halfThickness, pistonMaxX = centerX + halfThickness;
  const rodEndX = GEOMETRY_SI.rodEndAtRetractedX + positionM;
  return {
    positionM,
    piston: { center: cylinderPoint(centerX), minX: pistonMinX, maxX: pistonMaxX, radiusM: GEOMETRY_SI.boreRadiusM, thicknessM: DIMENSIONS_SI.pistonThicknessM },
    rod: { start: cylinderPoint(centerX), end: cylinderPoint(rodEndX), lengthM: rodEndX - centerX, radiusM: GEOMETRY_SI.rodRadiusM },
    loadClevis: cylinderPoint(rodEndX),
    loadCarriage: cylinderPoint(rodEndX + .040),
    capFluid: fluidSection(capInsideX, pistonMinX, 0, GEOMETRY_SI.boreRadiusM),
    rodFluid: fluidSection(pistonMaxX, glandInsideX, GEOMETRY_SI.rodRadiusM, GEOMETRY_SI.boreRadiusM),
    seals: {
      piston: { center: cylinderPoint(centerX), outerRadiusM: GEOMETRY_SI.boreRadiusM, widthM: .004 },
      rod: { center: cylinderPoint(glandInsideX + .008), innerRadiusM: GEOMETRY_SI.rodRadiusM, outerRadiusM: .023, widthM: .004 },
      wiper: { center: cylinderPoint(glandInsideX + .020), innerRadiusM: GEOMETRY_SI.rodRadiusM, outerRadiusM: .021, widthM: .002 },
      guide: { center: cylinderPoint(glandInsideX + .014), innerRadiusM: GEOMETRY_SI.rodRadiusM, outerRadiusM: .024, widthM: .006 },
    },
    ports: { A: [...PORTS['cylinder-A'].position], B: [...PORTS['cylinder-B'].position] },
  };
}

export function tankGeometry(volumeM3) {
  const { min, max } = GEOMETRY_SI.tankInsideBounds;
  const footprintM2 = (max[0] - min[0]) * (max[2] - min[2]), capacityM3 = footprintM2 * (max[1] - min[1]);
  bounded(volumeM3, 'tank volumeM3', 0, capacityM3);
  const surfaceY = min[1] + volumeM3 / footprintM2;
  return { volumeM3, capacityM3, surfaceY, bounds: { min: [...min], max: [max[0], surfaceY, max[2]] } };
}

export const SPOOL_GEOMETRY = freeze({
  commandOffsetsM: { extend: .010, neutral: 0, retract: -.010 },
  bodyWindows: [
    { id: 'T1', port: 'T', centerX: -.040 }, { id: 'A', port: 'A', centerX: -.020 },
    { id: 'P', port: 'P', centerX: 0 }, { id: 'B', port: 'B', centerX: .020 }, { id: 'T2', port: 'T', centerX: .040 },
  ].map(window => ({ ...window, minX: window.centerX - .003, maxX: window.centerX + .003 })),
  grooveCentersM: [-.020, .020], grooveHalfWidthM: .0135,
  boreRadiusM: .009, landRadiusM: .0087, grooveRadiusM: .0055, spoolHalfLengthM: .065,
  axialBoreRadiusM: .002, axialBoreX: [-.048, .048], radialHoleCentersM: [-.040, 0, .040], radialHoleRadiusM: .0015,
});

const overlap = (a, b) => Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX) > 1e-12;
/** Derive open port groups from actual windows, grooves, and drilled bypass openings. */
export function connectionsFromSpoolGeometry(geometry) {
  const windows = geometry.bodyWindows;
  const parent = new Map(windows.map(window => [window.id, window.id]));
  const find = id => { let next = id; while (parent.get(next) !== next) next = parent.get(next); return next; };
  const join = nodes => { for (let index = 1; index < nodes.length; index++) parent.set(find(nodes[index]), find(nodes[0])); };
  // T1 and T2 join inside the stationary body, before the sole external T fitting.
  join(windows.filter(window => window.port === 'T').map(window => window.id));
  for (const groove of geometry.grooves) join(windows.filter(window => overlap(window, groove)).map(window => window.id));
  const bypassWindows = new Set();
  for (const hole of geometry.radialHoles) for (const window of windows) if (overlap(window, hole)) bypassWindows.add(window.id);
  join([...bypassWindows]);
  const groups = new Map();
  for (const window of windows) { const root = find(window.id); if (!groups.has(root)) groups.set(root, new Set()); groups.get(root).add(window.port); }
  const order = ['P', 'A', 'B', 'T'];
  const portGroups = [...groups.values()].map(group => [...group].sort((a, b) => order.indexOf(a) - order.indexOf(b))).filter(group => group.length > 1);
  const connections = [];
  for (const group of portGroups) for (let a = 0; a < group.length; a++) for (let b = a + 1; b < group.length; b++) connections.push(`${group[a]}-${group[b]}`);
  connections.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]) || order.indexOf(a[2]) - order.indexOf(b[2]));
  return { connections, portGroups, bypassPorts: [...new Set(windows.filter(window => bypassWindows.has(window.id)).map(window => window.port))].sort() };
}

export function spoolGeometry(command) {
  if (!Object.hasOwn(SPOOL_GEOMETRY.commandOffsetsM, command)) throw new RangeError(`Unknown spool command: ${String(command)}`);
  const offsetM = SPOOL_GEOMETRY.commandOffsetsM[command], s = SPOOL_GEOMETRY;
  const grooves = s.grooveCentersM.map(center => ({ minX: center + offsetM - s.grooveHalfWidthM, maxX: center + offsetM + s.grooveHalfWidthM, radiusM: s.grooveRadiusM }));
  const minX = -s.spoolHalfLengthM + offsetM, maxX = s.spoolHalfLengthM + offsetM;
  const lands = [{ minX, maxX: grooves[0].minX }, { minX: grooves[0].maxX, maxX: grooves[1].minX }, { minX: grooves[1].maxX, maxX }].map(land => ({ ...land, radiusM: s.landRadiusM }));
  const geometry = {
    command, offsetM, axisOrigin: [...GEOMETRY_SI.valveCenter], minX, maxX,
    bodyWindows: s.bodyWindows.map(window => ({ ...window })), grooves, lands,
    axialBore: { minX: s.axialBoreX[0] + offsetM, maxX: s.axialBoreX[1] + offsetM, radiusM: s.axialBoreRadiusM },
    radialHoles: s.radialHoleCentersM.map(center => ({ centerX: center + offsetM, minX: center + offsetM - s.radialHoleRadiusM, maxX: center + offsetM + s.radialHoleRadiusM, radiusM: s.radialHoleRadiusM })),
  };
  return { ...geometry, ...connectionsFromSpoolGeometry(geometry) };
}

const port = (partId, position, normal) => ({ partId, position, normal });
export const PORTS = freeze({
  'strainer-out': port('suction-strainer', [-.400, .040, .160], [0, 0, -1]),
  'tank-suction': port('tank', [-.400, .050, .040], [0, 0, -1]),
  'pump-in': port('pump', [-.400, .115, -.100], [-1, 0, 0]),
  'pump-out': port('pump', [-.320, .115, -.100], [1, 0, 0]),
  'supply-tee': port('line-P', [-.245, .098, -.025], [0, 1, 0]),
  'valve-P': port('port-P', [-.130, .095, .130], [0, -1, 0]),
  'valve-A': port('port-A', [-.150, .175, .130], [0, 1, 0]),
  'valve-B': port('port-B', [-.110, .175, .130], [0, 1, 0]),
  'valve-T': port('port-T', [-.130, .135, .1775], [0, 0, 1]),
  'cylinder-A': port('cylinder-barrel', [capInsideX + capDeadLength / 2, .271, 0], [0, 1, 0]),
  'cylinder-B': port('cylinder-barrel', [glandInsideX - rodDeadLength / 2, .271, 0], [0, 1, 0]),
  'relief-in': port('relief-body', [-.235, .1275, .025], [0, -1, 0]),
  'relief-out': port('relief-body', [-.219, .158, .025], [1, 0, 0]),
  'return-tee': port('line-T', [-.055, .120, .200], [1, 0, 0]),
  'filter-in': port('return-filter', [.023, .130, .200], [-1, 0, 0]),
  'filter-out': port('return-filter', [.067, .130, .200], [1, 0, 0]),
  'tank-return': port('tank', [-.290, .120, .160], [1, 0, 0]),
});

function route(id, partId, from, to, intermediates, pressurePort, flowKeys) {
  return { id, partId, from, to, pressurePort, flowKeys, points: [[...PORTS[from].position], ...intermediates, [...PORTS[to].position]] };
}
export const CIRCUIT_ROUTES = freeze([
  route('pickup', 'line-suction', 'strainer-out', 'tank-suction', [[-.400, .045, .100]], 'T', ['pumpFromTank']),
  route('suction', 'line-suction', 'tank-suction', 'pump-in', [[-.430, .050, .010], [-.430, .115, -.100]], 'T', ['pumpFromTank']),
  route('pump-supply', 'line-P', 'pump-out', 'supply-tee', [[-.280, .115, -.100]], 'P', ['pumpFromTank']),
  route('valve-supply', 'line-P', 'supply-tee', 'valve-P', [[-.190, .080, .025], [-.130, .075, .100]], 'P', ['supplyToValve']),
  route('cap-line', 'line-A', 'valve-A', 'cylinder-A', [[-.150, .315, .130], [PORTS['cylinder-A'].position[0], .315, 0]], 'A', ['capIntoCylinder']),
  route('rod-line', 'line-B', 'valve-B', 'cylinder-B', [[-.110, .335, .130], [PORTS['cylinder-B'].position[0], .335, 0]], 'B', ['rodIntoCylinder']),
  route('valve-return', 'line-T', 'valve-T', 'return-tee', [[-.130, .135, .200]], 'T', ['valveToTank']),
  route('filter-supply', 'line-T', 'return-tee', 'filter-in', [[0, .120, .200]], 'T', ['valveToTank', 'reliefToTank']),
  route('filtered-return', 'line-T', 'filter-out', 'tank-return', [[.090, .130, .200], [.090, .120, .310], [-.260, .120, .310], [-.260, .120, .160]], 'T', ['valveToTank', 'reliefToTank']),
  route('relief-supply', 'line-relief', 'supply-tee', 'relief-in', [[-.235, .098, .025]], 'P', ['reliefToTank']),
  // Rise behind the valve, cross above its top rib, then descend into the common
  // return tee. The former diagonal passed through the central spool gallery.
  route('relief-return', 'line-relief', 'relief-out', 'return-tee', [[-.195, .158, .025], [-.195, .190, .025], [-.055, .190, .025], [-.055, .190, .200]], 'T', ['reliefToTank']),
]);

export function getCircuitRoutes() {
  return CIRCUIT_ROUTES.map(item => ({ ...item, flowKeys: [...item.flowKeys], points: item.points.map(point => [...point]) }));
}

export const COMPONENTS = freeze([
  ['tank', '오일 탱크', '복귀 오일을 모읍니다. 로드가 전진하면 실린더의 총 오일 체적이 늘어 탱크 수위가 내려갑니다.', '강철'],
  ['tank-oil', '탱크 오일', '수위는 모델의 저장 체적과 탱크 내부 치수에서 정합니다. 압력 색은 온도를 나타내지 않습니다.', '작동유'],
  ['suction-strainer', '흡입망', '탱크 안에서 펌프 흡입 입구를 보호하는 대표 망입니다. 복귀 필터와 구분됩니다.', '강철 망'],
  ['pump', '유압 펌프', '지정 유량을 공급합니다. 압력은 부하와 회로 연결에 의해 결정되며 설정 압력을 항상 만들어 내는 것은 아닙니다.', '주철 · 강철'],
  ['pump-drive', '펌프 구동부', '펌프 축의 대표 구동부입니다. 관찰 일시정지는 실제 장비의 전원 차단을 뜻하지 않습니다.', '강철 · 알루미늄'],
  ['return-filter', '복귀 필터', '방향밸브와 릴리프에서 돌아온 오일을 탱크 전에 여과합니다. 이 모델은 필터 압력 손실을 계산하지 않습니다.', '강철 · 여과지'],
  ['directional-body', '방향밸브 몸체', 'P·A·B·T 네 외부 포트와 내부 환형 갤러리를 연결합니다. 내부의 두 T 갤러리는 하나의 복귀 포트로 합쳐집니다.', '주철'],
  ['directional-spool', '3위치 스풀', '두 외곽 홈과 중립 전용 내부 바이패스가 전진·중립·후진 연결을 만듭니다. 중간 개도는 계산하지 않습니다.', '경화 강철'],
  ['centering-springs', '중립 복귀 스프링', '중립 위치를 설명하는 대표 스프링입니다. 실제 스프링 강성이나 과도응답을 계산하지 않습니다.', '스프링 강철'],
  ['port-P', 'P 공급 포트', '펌프에서 방향밸브로 공급합니다. 중립에서는 T로 순환합니다.', '가공된 통로'],
  ['port-A', 'A 캡측 포트', '실린더의 로드가 없는 쪽 액실에 연결됩니다. 전진 중 공급, 후진 중 복귀합니다.', '가공된 통로'],
  ['port-B', 'B 로드측 포트', '로드가 차지한 면적을 뺀 환형 액실에 연결됩니다. 후진 중 공급, 전진 중 복귀합니다.', '가공된 통로'],
  ['port-T', 'T 복귀 포트', '방향밸브의 복귀 오일을 필터와 탱크로 보냅니다. 내부 T1·T2와 연결된 단일 외부 포트입니다.', '가공된 통로'],
  ['relief-body', '릴리프 몸체', '펌프 출구의 공급 분기와 탱크 복귀를 연결합니다.', '강철'],
  ['relief-poppet', '릴리프 포핏', '압력 한계나 행정 끝 정지에서 우회 유로가 열림을 보여 줍니다. 표시 이동량은 실제 개도 계측값이 아닙니다.', '경화 강철'],
  ['relief-spring', '릴리프 스프링', '압력 제한 설정에 대응하는 대표 스프링입니다. 실제 예압·변형을 해석하지 않습니다.', '스프링 강철'],
  ['relief-adjuster', '릴리프 설정 나사', '압력 한계를 조절합니다. 유량을 직접 정하거나 속도를 항상 높이는 조작이 아닙니다.', '강철'],
  ['cylinder-barrel', '실린더 배럴', '내경 60 mm의 원통에서 피스톤이 300 mm 이동합니다. 절개에서는 관찰 쪽 벽을 제거합니다.', '강철'],
  ['cap-end', '캡측 끝단', '로드가 없는 쪽 액실을 닫습니다. A 피팅은 최소 여유 공간 안에 남습니다.', '강철'],
  ['rod-gland', '로드측 글랜드', '로드 가이드·씰·와이퍼를 지지하며 B 액실을 닫습니다.', '강철 · 베어링 재료'],
  ['piston', '피스톤', '양실 압력과 서로 다른 유효 면적으로 힘이 정해집니다. 위치는 모델의 변위를 그대로 사용합니다.', '강철'],
  ['piston-seal', '피스톤 씰', '두 액실을 구분하는 대표 밀봉부입니다. 표시를 꺼도 모델에 누설이 생기는 것은 아닙니다.', '밀봉재'],
  ['rod', '피스톤 로드', '로드측의 유효 면적을 줄이며 피스톤과 부하 캐리지를 연결합니다.', '표면 처리 강철'],
  ['rod-guide', '로드 가이드', '글랜드 안에서 로드를 지지하는 고정 안내 부품입니다.', '베어링 재료'],
  ['rod-seal', '로드 씰', '로드가 글랜드를 통과하는 자리의 대표 밀봉부입니다.', '밀봉재'],
  ['wiper', '와이퍼', '노출 로드 표면의 오염물을 닦는 외측 부품입니다.', '탄성체'],
  ['load-carriage', '저항 부하 캐리지', '수평 이동을 거스르는 시험 저항을 나타냅니다. 중력으로 스스로 내려가는 하중이 아닙니다.', '강철'],
  ['load-guide', '부하 안내 레일', '로드 끝과 연결된 캐리지의 수평 이동을 안내합니다.', '강철'],
  ['line-suction', '흡입 배관', '탱크 흡입망에서 펌프까지 연결됩니다.', '강철 피팅 · 호스'],
  ['line-P', '공급 배관', '펌프 출구에서 릴리프와 방향밸브 P로 나뉩니다.', '강철 피팅 · 호스'],
  ['line-A', 'A 배관', '방향밸브 A와 캡측을 연결합니다. 화살표는 실제 부호 있는 유량을 따릅니다.', '강철 피팅 · 호스'],
  ['line-B', 'B 배관', '방향밸브 B와 로드측을 연결합니다. 같은 공급 유량이라도 반대쪽 복귀 유량은 다를 수 있습니다.', '강철 피팅 · 호스'],
  ['line-T', '복귀 배관', '방향밸브·릴리프 복귀를 합쳐 필터와 탱크로 보냅니다.', '강철 피팅 · 호스'],
  ['line-relief', '릴리프 우회 배관', '공급 분기에서 릴리프를 지나 공통 복귀로 연결됩니다.', '강철 피팅 · 호스'],
].map(([id, name, description, material]) => ({ id, name, description, material })));
