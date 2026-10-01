import test from 'node:test';
import assert from 'node:assert/strict';
import { DIMENSIONS_SI, createExperiment, instantSnapshot, setCommand } from '../src/model.js';
import { GEOMETRY_SI, SPOOL_GEOMETRY, PORTS, CIRCUIT_ROUTES, COMPONENTS, cylinderGeometry, tankGeometry, spoolGeometry, connectionsFromSpoolGeometry, getCircuitRoutes } from '../src/geometry.js';

const close = (a, b, tolerance = 1e-12) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);

test('actual cylinder spaces match independent circular and annular volumes throughout the stroke', () => {
  const capArea = Math.PI * .060 ** 2 / 4, annularArea = Math.PI * (.060 ** 2 - .035 ** 2) / 4;
  for (const positionM of [0, .001, .075, .150, .225, .299, .300]) {
    const geometry = cylinderGeometry(positionM), snapshot = instantSnapshot(createExperiment({}, { positionM }));
    close(geometry.piston.center[0], -.265 + positionM);
    close(geometry.capFluid.lengthM, .006 + positionM);
    close(geometry.rodFluid.lengthM, .006 + .300 - positionM);
    close(geometry.capFluid.volumeM3, capArea * (.006 + positionM));
    close(geometry.rodFluid.volumeM3, annularArea * (.006 + .300 - positionM));
    close(geometry.capFluid.volumeM3, snapshot.volumesM3.cap);
    close(geometry.rodFluid.volumeM3, snapshot.volumesM3.rod);
    close(geometry.capFluid.maxX, geometry.piston.minX); close(geometry.rodFluid.minX, geometry.piston.maxX);
    close(geometry.rod.lengthM, .425); close(geometry.rod.end[0], .160 + positionM);
    assert.ok(geometry.rod.end[0] > GEOMETRY_SI.glandX[1]);
    assert.deepEqual(geometry.loadClevis, geometry.rod.end);
  }
});

test('fixed cylinder ports and seals remain in their own spaces at both end stops', () => {
  const first = cylinderGeometry(0), last = cylinderGeometry(.3);
  assert.deepEqual(first.ports, last.ports);
  close(first.capFluid.volumeM3, DIMENSIONS_SI.capDeadVolumeM3);
  close(last.rodFluid.volumeM3, DIMENSIONS_SI.rodDeadVolumeM3);
  close(first.capFluid.lengthM, .006); close(last.rodFluid.lengthM, .006);
  // A 3 mm axial drilling stays wholly inside each minimum end chamber.
  for (const geometry of [first, last]) {
    const a = geometry.ports.A[0], b = geometry.ports.B[0];
    assert.ok(a - .0015 >= geometry.capFluid.minX && a + .0015 <= geometry.capFluid.maxX);
    assert.ok(b - .0015 >= geometry.rodFluid.minX && b + .0015 <= geometry.rodFluid.maxX);
    assert.ok(geometry.piston.minX > GEOMETRY_SI.capInsideX); assert.ok(geometry.piston.maxX < GEOMETRY_SI.glandInsideX);
    close(geometry.seals.piston.center[0], geometry.piston.center[0]);
    for (const name of ['rod', 'guide', 'wiper']) { const seal = geometry.seals[name]; assert.ok(seal.center[0] - seal.widthM / 2 >= GEOMETRY_SI.glandX[0]); assert.ok(seal.center[0] + seal.widthM / 2 <= GEOMETRY_SI.glandX[1]); }
  }
  assert.deepEqual(first.seals.rod, last.seals.rod); assert.deepEqual(first.seals.guide, last.seals.guide); assert.deepEqual(first.seals.wiper, last.seals.wiper);
});

test('tank level and actual cylinder fluid preserve the model total without hidden volumes', () => {
  let total = null;
  for (const positionM of [0, .1, .2, .3]) {
    const cylinder = cylinderGeometry(positionM), snapshot = instantSnapshot(createExperiment({}, { positionM })), tank = tankGeometry(snapshot.volumesM3.tank);
    const bounds = tank.bounds, renderedTankVolume = (bounds.max[0] - bounds.min[0]) * (bounds.max[1] - bounds.min[1]) * (bounds.max[2] - bounds.min[2]);
    close(renderedTankVolume, snapshot.volumesM3.tank);
    const actualTotal = renderedTankVolume + cylinder.capFluid.volumeM3 + cylinder.rodFluid.volumeM3;
    close(actualTotal, snapshot.volumesM3.totalFluid);
    if (total !== null) close(actualTotal, total); total = actualTotal;
    assert.ok(PORTS['strainer-out'].position[1] < tank.surfaceY);
    assert.ok(PORTS['tank-return'].position[1] < tank.surfaceY);
    assert.ok(tank.surfaceY < GEOMETRY_SI.tankInsideBounds.max[1]);
  }
});

test('spool connections are derived from machined grooves and a neutral-only drilled bypass', () => {
  const expected = { extend: ['P-A', 'B-T'], neutral: ['P-T'], retract: ['P-B', 'A-T'] };
  for (const command of Object.keys(expected)) {
    const spool = spoolGeometry(command), snapshot = instantSnapshot(setCommand(createExperiment(), command));
    assert.deepEqual(spool.connections, expected[command]); assert.deepEqual(spool.connections, snapshot.connections);
    assert.ok(spool.minX > -GEOMETRY_SI.valveBodyHalfLengthM && spool.maxX < GEOMETRY_SI.valveBodyHalfLengthM);
    assert.equal(spool.lands.length, 3); assert.equal(spool.grooves.length, 2);
    for (const hole of spool.radialHoles) assert.ok(spool.lands.some(land => hole.minX > land.minX && hole.maxX < land.maxX));
    if (command === 'neutral') assert.deepEqual(spool.bypassPorts, ['P', 'T']); else assert.deepEqual(spool.bypassPorts, []);
  }
  // Removing the actual internal holes removes P→T; this cannot pass via a command lookup.
  const closedCenter = spoolGeometry('neutral'); closedCenter.radialHoles = [];
  assert.deepEqual(connectionsFromSpoolGeometry(closedCenter).connections, []);
  const noGrooves = spoolGeometry('extend'); noGrooves.grooves = [];
  assert.deepEqual(connectionsFromSpoolGeometry(noGrooves).connections, []);
});

test('spool lands, grooves and hollow core are non-overlapping complete axial sections', () => {
  for (const command of ['extend', 'neutral', 'retract']) {
    const spool = spoolGeometry(command);
    const sections = [...spool.lands, ...spool.grooves].sort((a, b) => a.minX - b.minX);
    close(sections[0].minX, spool.minX); close(sections.at(-1).maxX, spool.maxX);
    for (let index = 0; index < sections.length; index++) {
      assert.ok(sections[index].maxX > sections[index].minX);
      if (index) close(sections[index - 1].maxX, sections[index].minX);
      assert.ok(sections[index].radiusM > spool.axialBore.radiusM);
    }
    assert.ok(spool.axialBore.minX > spool.minX && spool.axialBore.maxX < spool.maxX);
    close(spool.maxX - spool.minX, .130);
  }
  assert.ok(SPOOL_GEOMETRY.landRadiusM < SPOOL_GEOMETRY.boreRadiusM);
});

test('every route terminates on the shared fittings and all external nodes form one circuit', () => {
  const ids = new Set(COMPONENTS.map(component => component.id)); assert.equal(ids.size, 34); assert.equal(ids.size, COMPONENTS.length);
  const graph = new Map(Object.keys(PORTS).map(id => [id, new Set()]));
  const join = (from, to) => { graph.get(from).add(to); graph.get(to).add(from); };
  for (const route of CIRCUIT_ROUTES) {
    assert.ok(ids.has(route.partId)); assert.deepEqual(route.points[0], PORTS[route.from].position); assert.deepEqual(route.points.at(-1), PORTS[route.to].position);
    assert.ok(route.points.flat().every(Number.isFinite)); assert.ok(['P', 'A', 'B', 'T'].includes(route.pressurePort));
    join(route.from, route.to);
    for (let index = 1; index < route.points.length; index++) assert.ok(Math.hypot(...route.points[index].map((coordinate, axis) => coordinate - route.points[index - 1][axis])) > 1e-6);
  }
  // Add physical internal component passages, without implying all valve ports are open.
  for (const [a, b] of [['pump-in', 'pump-out'], ['filter-in', 'filter-out'], ['relief-in', 'relief-out'], ['tank-return', 'strainer-out']]) join(a, b);
  for (const port of ['valve-A', 'valve-B', 'valve-T']) join('valve-P', port);
  const visited = new Set(), pending = ['strainer-out'];
  while (pending.length) { const id = pending.pop(); if (visited.has(id)) continue; visited.add(id); pending.push(...graph.get(id)); }
  assert.equal(visited.size, Object.keys(PORTS).length);
  for (const port of Object.values(PORTS)) { assert.ok(ids.has(port.partId)); close(Math.hypot(...port.normal), 1); }
});

test('route metadata carries the actual signed chamber flow and combined filter return', () => {
  for (const command of ['extend', 'neutral', 'retract']) {
    const snapshot = instantSnapshot(setCommand(createExperiment(), command));
    const flows = new Map(CIRCUIT_ROUTES.map(route => [route.id, route.flowKeys.reduce((sum, key) => sum + snapshot.flowsM3s[key], 0)]));
    assert.ok([...flows.values()].every(Number.isFinite));
    close(flows.get('pump-supply'), flows.get('valve-supply') + flows.get('relief-supply'));
    close(flows.get('filter-supply'), flows.get('valve-return') + flows.get('relief-return'));
    close(flows.get('filter-supply'), flows.get('filtered-return'));
    if (command === 'extend') { assert.ok(flows.get('cap-line') > 0); assert.ok(flows.get('rod-line') < 0); }
    if (command === 'retract') { assert.ok(flows.get('cap-line') < 0); assert.ok(flows.get('rod-line') > 0); }
    if (command === 'neutral') { assert.equal(flows.get('cap-line'), 0); assert.equal(flows.get('rod-line'), 0); }
  }
});

test('relief return clears the solid valve and cylinder instead of crossing the spool gallery', () => {
  const route = CIRCUIT_ROUTES.find(route => route.id === 'relief-return');
  assert.deepEqual(route.points[0], PORTS['relief-out'].position);
  assert.deepEqual(route.points.at(-1), PORTS['return-tee'].position);
  assert.deepEqual(route.flowKeys, ['reliefToTank']); assert.equal(route.pressurePort, 'T');
  // Conservative envelope includes the top/bottom ribs, stem and T fitting.
  // A 4.8 mm hose radius plus 3 mm free space must clear this complete assembly.
  const min = [-.218, .093, .090], max = [-.017, .176, .184], hoseRadius = .0048;
  for (let index = 1; index < route.points.length; index++) {
    const a = route.points[index - 1], b = route.points[index];
    for (let sample = 0; sample <= 100; sample++) {
      const p = a.map((value, axis) => value + (b[axis] - value) * sample / 100);
      const distanceToValve = Math.hypot(...p.map((value, axis) => Math.max(min[axis] - value, 0, value - max[axis])));
      assert.ok(distanceToValve > hoseRadius + .003, `relief return crosses valve at ${p}`);
      if (p[0] >= GEOMETRY_SI.barrelX[0] && p[0] <= GEOMETRY_SI.barrelX[1]) {
        const radialDistance = Math.hypot(p[1] - GEOMETRY_SI.cylinderAxisY, p[2] - GEOMETRY_SI.cylinderAxisZ);
        assert.ok(radialDistance > GEOMETRY_SI.barrelOuterRadiusM + hoseRadius + .003, 'relief return touches barrel');
      }
    }
  }
});

test('geometry rejects invalid position/volume/command and exposes detached route copies', () => {
  for (const value of [-.001, .301, NaN, Infinity, '0.1', null]) assert.throws(() => cylinderGeometry(value), RangeError);
  for (const value of [-.001, 1, NaN, Infinity, '0.006']) assert.throws(() => tankGeometry(value), RangeError);
  for (const value of ['left', '', null, undefined]) assert.throws(() => spoolGeometry(value), RangeError);
  const copy = getCircuitRoutes(); copy[0].points[0][0] = 900; copy[0].flowKeys[0] = 'bad';
  assert.notEqual(CIRCUIT_ROUTES[0].points[0][0], 900); assert.equal(CIRCUIT_ROUTES[0].flowKeys[0], 'pumpFromTank');
});
