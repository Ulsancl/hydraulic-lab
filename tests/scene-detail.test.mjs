import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PUMP_DETAIL as P, RELIEF_DETAIL as R, pumpHousingGeometry, pumpCoverGeometry, pumpGearGeometry, pumpRadialClearanceBound, reliefHousingGeometry, reliefSeatGeometry, reliefPoppetGeometry, engineeringFinish } from '../src/mechanical-geometry.js';

const TAU = Math.PI * 2;
const near = (actual, expected, tolerance = 1e-8) => assert(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
function section(geometry, z = 0) {
  const p = geometry.attributes.position, edges = [];
  for (let i = 0; i < p.count; i += 3) {
    const triangle = [0, 1, 2].map(j => [p.getX(i + j), p.getY(i + j), p.getZ(i + j)]), crossings = [];
    for (let j = 0; j < 3; j++) {
      const a = triangle[j], b = triangle[(j + 1) % 3];
      if ((a[2] < z && b[2] > z) || (a[2] > z && b[2] < z)) { const t = (z - a[2]) / (b[2] - a[2]); crossings.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]); }
    }
    if (crossings.length === 2) edges.push(crossings);
  }
  return edges;
}
function inside(point, edges) {
  let crossings = 0;
  for (const [a, b] of edges) if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < a[0] + (point[1] - a[1]) * (b[0] - a[0]) / (b[1] - a[1])) crossings++;
  return crossings % 2 === 1;
}
function rotate(point, angle, centerX) { return [centerX + point[0] * Math.cos(angle) - point[1] * Math.sin(angle), point[0] * Math.sin(angle) + point[1] * Math.cos(angle)]; }
function intersects(a, b, c, d) {
  const orient = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return orient(a, b, c) * orient(a, b, d) < -1e-22 && orient(c, d, a) * orient(c, d, b) < -1e-22;
}
function audit(geometry) {
  const p = geometry.attributes.position, n = geometry.attributes.normal, edges = new Map(); let volume = 0;
  const key = p => p.map(value => Math.round(value * 1e8)).join(',');
  for (let i = 0; i < p.count; i += 3) {
    const vertices = [0, 1, 2].map(j => new THREE.Vector3().fromBufferAttribute(p, i + j));
    const face = vertices[1].clone().sub(vertices[0]).cross(vertices[2].clone().sub(vertices[0]));
    assert(face.lengthSq() > 1e-24, 'no zero-area facets'); volume += vertices[0].dot(vertices[1].clone().cross(vertices[2])) / 6;
    for (let j = 0; j < 3; j++) {
      const normal = new THREE.Vector3().fromBufferAttribute(n, i + j); near(normal.length(), 1, 1e-5); assert(normal.dot(face) > 0, 'normal follows outward winding');
      const a = key(vertices[j].toArray()), b = key(vertices[(j + 1) % 3].toArray()), id = a < b ? `${a}|${b}` : `${b}|${a}`;
      const item = edges.get(id) || [0, 0]; item[0]++; item[1] += a < b ? 1 : -1; edges.set(id, item);
    }
  }
  for (const [count, orientation] of edges.values()) { assert.equal(count, 2, 'closed material surface'); assert.equal(orientation, 0, 'consistent seam winding'); }
  assert(volume > 0); for (const attribute of Object.values(geometry.attributes)) assert([...attribute.array].every(Number.isFinite));
}

test('pump shell, chamfered covers, gears and conical seat/poppet are closed finite solids with unit outward normals', () => {
  for (const factory of [pumpHousingGeometry, pumpCoverGeometry, pumpGearGeometry, reliefHousingGeometry, () => reliefHousingGeometry(true), reliefSeatGeometry, () => reliefSeatGeometry(false), () => reliefSeatGeometry(true), reliefPoppetGeometry]) {
    const geometry = factory(); audit(geometry); geometry.dispose();
  }
});

test('every tooth stays inside actual twin-bore mesh at every full-rotation sample including its axial bevel sections', () => {
  const housing = pumpHousingGeometry(), gear = pumpGearGeometry(), phases = 360;
  const bounds = pumpRadialClearanceBound(gear); assert(bounds.radialClearanceLowerBoundM > .00065);
  for (const z of [-.00829, -.00815, -.0041, 0, .0041, .00815, .00829]) {
    const wall = section(housing, z), outline = section(gear, z); assert(wall.length && outline.length);
    for (let phase = 0; phase < phases; phase++) for (let index = 0; index < 2; index++) {
      const angle = phase * TAU / phases * (index ? -1 : 1) + (index ? Math.PI / 12 : 0);
      for (const [a, b] of outline) for (const point of [a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]]) {
        assert(!inside(rotate(point, angle, P.gearCentersX[index]), wall), 'rendered gear intersects rendered housing');
      }
    }
  }
});

test('gear pair keeps the correct half-tooth phase without polygon interference through complete rotation', () => {
  const raw = section(pumpGearGeometry());
  for (let phase = 0; phase < 360; phase++) {
    const angle = phase * TAU / 360;
    const gears = P.gearCentersX.map((x, index) => raw.map(edge => edge.map(point => rotate(point, index ? -angle + Math.PI / 12 : angle, x))));
    for (const edge of gears[0]) {
      assert(!inside(edge[0], gears[1]), 'tooth tip cannot enter opposite gear');
      for (const other of gears[1]) assert(!intersects(...edge, ...other), 'gear flank segments must not cross');
    }
  }
});

test('rear and front covers leave real axial clearance for gear bevels and two shaft passages', () => {
  const gear = pumpGearGeometry(), cover = pumpCoverGeometry();
  near(cover.boundingBox.max.z - cover.boundingBox.min.z, P.coverThicknessM);
  near(P.bodyHalfWidthM - gear.boundingBox.max.z, .0003);
  near(gear.boundingBox.min.z + P.bodyHalfWidthM, .0003);
  const plate = section(cover);
  for (const x of P.gearCentersX) for (let i = 0; i < 360; i++) {
    assert(!inside([x + P.shaftRadiusM * Math.cos(i * TAU / 360), P.shaftRadiusM * Math.sin(i * TAU / 360)], plate));
  }
});

test('cover edge finishing preserves the finished bearing bore instead of cutting into its bushing', () => {
  const cover = pumpCoverGeometry(); near(cover.boundingBox.max.x, P.bodyOuterRadiusM);
  for (const z of [-.001999, -.00185, 0, .00185, .001999]) {
    const plate = section(cover, z);
    for (const centerX of P.gearCentersX) for (let i = 0; i < 80; i++) {
      const a = i * TAU / 80, b = (i + 1) * TAU / 80, r = P.journalOuterRadiusM - 1e-7;
      for (const point of [[centerX + r * Math.cos(a), r * Math.sin(a)], [centerX + r * (Math.cos(a) + Math.cos(b)) / 2, r * (Math.sin(a) + Math.sin(b)) / 2]]) {
        assert(!inside(point, plate), 'the complete polygonal bushing fits the beveled cover');
      }
    }
  }
});

test('actual conical mesh contact closes across the complete seating band and opens by exactly the displayed lift', () => {
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), seat = new THREE.Mesh(reliefSeatGeometry(), material), poppet = new THREE.Mesh(reliefPoppetGeometry(), material);
  const ray = new THREE.Raycaster(); seat.updateMatrixWorld();
  for (const lift of [0, R.displayLiftM]) {
    poppet.position.y = lift; poppet.updateMatrixWorld();
    for (let i = 0; i < 96; i++) for (const radius of [.0041, .0048, .0057, .0064]) {
      const angle = (i + .37) * TAU / 96, x = radius * Math.cos(angle), z = radius * Math.sin(angle);
      ray.set(new THREE.Vector3(x, .04, z), new THREE.Vector3(0, -1, 0)); const seatHit = ray.intersectObject(seat)[0];
      ray.set(new THREE.Vector3(x, -.04, z), new THREE.Vector3(0, 1, 0)); const poppetHit = ray.intersectObject(poppet)[0];
      assert(seatHit && poppetHit); near(poppetHit.point.y - seatHit.point.y, lift);
    }
  }
});

test('the relief seat fits an actual stepped housing pocket rather than intersecting a smaller cylindrical wall', () => {
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const seat = new THREE.Mesh(reliefSeatGeometry(), material), housing = new THREE.Mesh(reliefHousingGeometry(), material), ray = new THREE.Raycaster();
  seat.updateMatrixWorld(); housing.updateMatrixWorld();
  for (const y of [-.0269, -.023, -.019, -.015, -.013]) for (const angle of [-.24, -.71, -1.15, -1.86, -2.68]) {
    const direction = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
    ray.set(new THREE.Vector3(0, y, 0), direction); const wall = ray.intersectObject(housing)[0];
    ray.set(direction.clone().multiplyScalar(.03).add(new THREE.Vector3(0, y, 0)), direction.clone().negate()); const outerSeat = ray.intersectObject(seat)[0];
    assert(wall && outerSeat);
    const wallRadius = Math.hypot(wall.point.x, wall.point.z), seatRadius = Math.hypot(outerSeat.point.x, outerSeat.point.z);
    assert(wallRadius + 1e-8 >= seatRadius, 'seat material must remain inside enlarged pocket');
    assert(wallRadius > .0099, 'the bore is enlarged locally to fit the seat');
  }
});

test('procedural manufacturing finishes are subtle, reproducible and mip-filtered', () => {
  for (const kind of ['turned', 'cast']) {
    const a = engineeringFinish(kind), b = engineeringFinish(kind); assert.deepEqual(a.image.data, b.image.data);
    assert.equal(a.image.width, 512); assert.equal(a.minFilter, THREE.LinearMipmapLinearFilter); assert(a.generateMipmaps);
    assert(a.image.data.every((value, i) => i % 4 === 3 ? value === 255 : value >= 100 && value <= 155)); a.dispose(); b.dispose();
  }
});
