import * as THREE from 'three';

const TAU = Math.PI * 2;
export const PUMP_DETAIL = Object.freeze({
  gearCentersX: Object.freeze([-.015, .015]), teeth: 12, pitchRadiusM: .015,
  toothOuterRadiusM: .0172, toothBevelM: .0003, gearHalfWidthM: .0083,
  cavityRadiusM: .0182, bodyOuterRadiusM: .038, bodyHalfWidthM: .0086,
  coverThicknessM: .004, shaftRadiusM: .005, journalInnerRadiusM: .0051,
  journalOuterRadiusM: .0082, boltRadiusM: .0018, boltHoleRadiusM: .0022,
  bolts: Object.freeze([[-.025, -.021], [-.025, .021], [.025, -.021], [.025, .021]].map(Object.freeze)),
});

export const RELIEF_DETAIL = Object.freeze({
  tipY: -.023, headRadiusM: .007, coneHeightM: .011,
  contactInnerRadiusM: .004, contactOuterRadiusM: .0065,
  seatOuterRadiusM: .010, seatBottomY: -.027,
  displayLiftM: .0035, springBottomY: -.002, springTopY: .023,
});
export const reliefConeY = radius => RELIEF_DETAIL.tipY + radius * RELIEF_DETAIL.coneHeightM / RELIEF_DETAIL.headRadiusM;

function circleHole(shape, x, y, radius) {
  const path = new THREE.Path(); path.absarc(x, y, radius, 0, TAU, true); shape.holes.push(path);
}

// The union boundary of both gear bores, sampled on the real circles. A single
// central bore would clip the tips by over 10 mm at the present shaft spacing.
export function pumpCavityOutline(segmentsPerArc = 128) {
  const d = PUMP_DETAIL.gearCentersX[1], r = PUMP_DETAIL.cavityRadiusM, alpha = Math.acos(d / r), points = [];
  for (const [center, start] of [[-d, alpha], [d, Math.PI + alpha]]) {
    for (let i = 0; i < segmentsPerArc; i++) {
      const angle = start + (TAU - 2 * alpha) * i / segmentsPerArc;
      points.push([center + r * Math.cos(angle), r * Math.sin(angle)]);
    }
  }
  return points;
}

function smoothAxialWalls(geometry, circles) {
  const p = geometry.attributes.position, n = geometry.attributes.normal;
  for (let i = 0; i < p.count; i += 3) {
    if (Math.abs(n.getZ(i)) > 1e-6) continue;
    const circle = circles.find(([cx, cy, radius]) => [0, 1, 2].every(j => Math.abs(Math.hypot(p.getX(i + j) - cx, p.getY(i + j) - cy) - radius) < 1e-8));
    if (!circle) continue;
    const [cx, cy] = circle, sign = (p.getX(i) - cx) * n.getX(i) + (p.getY(i) - cy) * n.getY(i) < 0 ? -1 : 1;
    for (let j = 0; j < 3; j++) {
      const x = p.getX(i + j) - cx, y = p.getY(i + j) - cy, length = Math.hypot(x, y);
      n.setXYZ(i + j, sign * x / length, sign * y / length, 0);
    }
  }
  return geometry;
}

function machinedFaceUV(geometry, radius) {
  const p = geometry.attributes.position, n = geometry.attributes.normal, uv = geometry.attributes.uv;
  for (let i = 0; i < p.count; i++) if (Math.abs(n.getZ(i)) > .99) uv.setXY(i, .5 + p.getX(i) / (2 * radius), .5 + p.getY(i) / (2 * radius));
  return geometry;
}

function pumpPlateShape(cavity, bevelOffset = 0) {
  const shape = new THREE.Shape(); shape.absarc(0, 0, PUMP_DETAIL.bodyOuterRadiusM - bevelOffset, 0, TAU, false);
  if (cavity) {
    const points = pumpCavityOutline().reverse();
    const hole = new THREE.Path(points.map(([x, y]) => new THREE.Vector2(x, y))); hole.closePath(); shape.holes.push(hole);
  } else for (const x of PUMP_DETAIL.gearCentersX) circleHole(shape, x, 0, PUMP_DETAIL.journalOuterRadiusM + bevelOffset);
  for (const [x, y] of PUMP_DETAIL.bolts) circleHole(shape, x, y, PUMP_DETAIL.boltHoleRadiusM + bevelOffset);
  return shape;
}

export function pumpHousingGeometry() {
  const geometry = new THREE.ExtrudeGeometry(pumpPlateShape(true), { depth: 2 * PUMP_DETAIL.bodyHalfWidthM, bevelEnabled: false, curveSegments: 80 });
  geometry.translate(0, 0, -PUMP_DETAIL.bodyHalfWidthM);
  smoothAxialWalls(geometry, [[0, 0, PUMP_DETAIL.bodyOuterRadiusM], ...PUMP_DETAIL.gearCentersX.map(x => [x, 0, PUMP_DETAIL.cavityRadiusM]), ...PUMP_DETAIL.bolts.map(([x, y]) => [x, y, PUMP_DETAIL.boltHoleRadiusM])]);
  machinedFaceUV(geometry, PUMP_DETAIL.bodyOuterRadiusM); geometry.computeBoundingBox(); return geometry;
}

export function pumpCoverGeometry() {
  // Extrude bevels expand the outer polygon and shrink holes. Offset the source
  // circles by the polygon's exact miter distance so the finished bore accepts
  // its bushing and the outer wall still matches the main housing diameter.
  const bevel = .00015, bevelOffset = bevel / Math.cos(Math.PI / 160);
  const geometry = new THREE.ExtrudeGeometry(pumpPlateShape(false, bevelOffset), { depth: PUMP_DETAIL.coverThicknessM - 2 * bevel, bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 2, curveSegments: 80 });
  geometry.translate(0, 0, -PUMP_DETAIL.coverThicknessM / 2 + bevel);
  smoothAxialWalls(geometry, [[0, 0, PUMP_DETAIL.bodyOuterRadiusM], ...PUMP_DETAIL.gearCentersX.map(x => [x, 0, PUMP_DETAIL.journalOuterRadiusM]), ...PUMP_DETAIL.bolts.map(([x, y]) => [x, y, PUMP_DETAIL.boltHoleRadiusM])]);
  machinedFaceUV(geometry, PUMP_DETAIL.bodyOuterRadiusM); geometry.computeBoundingBox(); return geometry;
}

export function pumpGearOutline() {
  const points = [];
  for (let tooth = 0; tooth < PUMP_DETAIL.teeth; tooth++) {
    const center = tooth * TAU / PUMP_DETAIL.teeth;
    for (const [offset, radius] of [[-.26, .0118], [-.15, .0118], [-.09, .0141], [-.046, .0172], [.046, .0172], [.09, .0141], [.15, .0118], [.26, .0118]]) {
      points.push([radius * Math.cos(center + offset), radius * Math.sin(center + offset)]);
    }
  }
  return points;
}

export function pumpGearGeometry() {
  const shape = new THREE.Shape(pumpGearOutline().map(([x, y]) => new THREE.Vector2(x, y)));
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: .016, steps: 1, bevelEnabled: true, bevelSegments: 1, bevelSize: PUMP_DETAIL.toothBevelM, bevelThickness: PUMP_DETAIL.toothBevelM });
  geometry.translate(0, 0, -.008); machinedFaceUV(geometry, PUMP_DETAIL.toothOuterRadiusM); geometry.computeBoundingBox(); return geometry;
}

export function pumpRadialClearanceBound(geometry) {
  const p = geometry.attributes.position; let outerRadiusM = 0;
  for (let i = 0; i < p.count; i++) outerRadiusM = Math.max(outerRadiusM, Math.hypot(p.getX(i), p.getY(i)));
  const contour = pumpCavityOutline().map(point => point.map(Math.fround));
  let boreInradiusM = Infinity;
  // Distance from either shaft to every actual chord of the union boundary.
  // Subtracting the complete swept gear disk guarantees clearance at every phase.
  for (const center of PUMP_DETAIL.gearCentersX) for (let i = 0; i < contour.length; i++) {
    const a = contour[i], b = contour[(i + 1) % contour.length], dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((center - a[0]) * dx - a[1] * dy) / (dx * dx + dy * dy)));
    boreInradiusM = Math.min(boreInradiusM, Math.hypot(a[0] + t * dx - center, a[1] + t * dy));
  }
  return { outerRadiusM, boreInradiusM, radialClearanceLowerBoundM: boreInradiusM - outerRadiusM };
}

// Closed solid of revolution about Y; analytic circumferential normals smooth
// the lathe marks while distinct profile edges remain crisp. Material groups
// are batched by finish so each part uses only one draw per finish.
export function revolvedSolid(profile, segments = 96, { start = 0, sweep = TAU } = {}) {
  const buckets = new Map(), maxR = Math.max(...profile.map(([r]) => r));
  const minY = Math.min(...profile.map(([, y]) => y)), maxY = Math.max(...profile.map(([, y]) => y));
  for (let j = 0; j < profile.length; j++) {
    const a = profile[j], b = profile[(j + 1) % profile.length], dr = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dr, dy);
    if (a[0] + b[0] === 0 || length === 0) continue;
    const material = a[2] || 0; if (!buckets.has(material)) buckets.set(material, { p: [], n: [], uv: [] }); const data = buckets.get(material);
    const point = (p, t) => [p[0] * Math.cos(t), p[1], p[0] * Math.sin(t)];
    const normal = t => [dy / length * Math.cos(t), -dr / length, dy / length * Math.sin(t)];
    const uv = (p, t) => Math.abs(dy) < 1e-10 ? [.5 + p[0] * Math.cos(t) / (2 * maxR), .5 + p[0] * Math.sin(t) / (2 * maxR)] : [t / TAU, (p[1] - minY) / (maxY - minY)];
    for (let i = 0; i < segments; i++) {
      const lo = start + i * sweep / segments, hi = start + (i + 1) * sweep / segments;
      for (const triangle of [[[a, lo], [b, lo], [b, hi]], [[a, lo], [b, hi], [a, hi]]]) {
        const vertices = triangle.map(([p, t]) => point(p, t));
        if (new THREE.Vector3(...vertices[1]).sub(new THREE.Vector3(...vertices[0])).cross(new THREE.Vector3(...vertices[2]).sub(new THREE.Vector3(...vertices[0]))).lengthSq() < 1e-26) continue;
        triangle.forEach(([p, t], k) => { data.p.push(...vertices[k]); data.n.push(...normal(t)); data.uv.push(...uv(p, t)); });
      }
    }
  }
  if (sweep < TAU - 1e-10) {
    const faces = THREE.ShapeUtils.triangulateShape(profile.map(([r, y]) => new THREE.Vector2(r, y)), []);
    if (!buckets.has(1)) buckets.set(1, { p: [], n: [], uv: [] }); const data = buckets.get(1);
    for (const [angle, sign] of [[start, -1], [start + sweep, 1]]) {
      const normal = new THREE.Vector3(-sign * Math.sin(angle), 0, sign * Math.cos(angle));
      for (const face of faces) {
        let vertices = face.map(i => new THREE.Vector3(profile[i][0] * Math.cos(angle), profile[i][1], profile[i][0] * Math.sin(angle)));
        if (vertices[1].clone().sub(vertices[0]).cross(vertices[2].clone().sub(vertices[0])).dot(normal) < 0) vertices = [vertices[0], vertices[2], vertices[1]];
        for (const point of vertices) { data.p.push(...point.toArray()); data.n.push(...normal.toArray()); data.uv.push(Math.hypot(point.x, point.z) / maxR, (point.y - minY) / (maxY - minY)); }
      }
    }
  }
  const p = [], n = [], uv = [], geometry = new THREE.BufferGeometry();
  for (const [material, data] of buckets) { geometry.addGroup(p.length / 3, data.p.length / 3, material); p.push(...data.p); n.push(...data.n); uv.push(...data.uv); }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); geometry.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3)); geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.computeBoundingBox(); return geometry;
}

export function reliefSeatGeometry(front = null) {
  const d = RELIEF_DETAIL, top = reliefConeY(d.contactOuterRadiusM), bottom = reliefConeY(d.contactInnerRadiusM);
  return revolvedSolid([[d.contactInnerRadiusM, d.seatBottomY], [d.seatOuterRadiusM - .0004, d.seatBottomY], [d.seatOuterRadiusM, d.seatBottomY + .0004], [d.seatOuterRadiusM, top - .0004], [d.seatOuterRadiusM - .0004, top], [d.contactOuterRadiusM, top], [d.contactInnerRadiusM, bottom]], front == null ? 96 : 48, front == null ? {} : { start: front ? 0 : Math.PI, sweep: Math.PI });
}

export function reliefHousingGeometry(front = false) {
  const d = RELIEF_DETAIL, top = reliefConeY(d.contactOuterRadiusM);
  // A real enlarged seat pocket bounded by two retaining shoulders. The seat
  // shares this mating radius instead of intersecting a uniform smaller bore.
  return revolvedSolid([[.009, -.0375, 1], [.016, -.0375], [.016, .0375, 1], [.009, .0375, 1], [.009, top, 1], [d.seatOuterRadiusM, top, 1], [d.seatOuterRadiusM, d.seatBottomY, 1], [.009, d.seatBottomY, 1]], 48, { start: front ? 0 : Math.PI, sweep: Math.PI });
}

export function reliefPoppetGeometry() {
  const d = RELIEF_DETAIL;
  return revolvedSolid([[0, d.tipY], [d.headRadiusM, reliefConeY(d.headRadiusM)], [0, reliefConeY(d.headRadiusM)]]);
}

export function engineeringFinish(kind = 'turned', size = 512) {
  const data = new Uint8Array(size * size * 4); let seed = 0x4769ab1;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    const noise = (seed >>> 0) / 4294967296 - .5, radius = Math.hypot(x - size / 2, y - size / 2);
    const value = Math.round(kind === 'cast' ? 128 + 45 * noise : 128 + 12 * Math.sin(radius * 1.37) + 5 * Math.sin(radius * 2.41) + 3 * noise);
    const i = (y * size + x) * 4; data[i] = data[i + 1] = data[i + 2] = value; data[i + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat); texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.generateMipmaps = true; texture.minFilter = THREE.LinearMipmapLinearFilter; texture.magFilter = THREE.LinearFilter; texture.needsUpdate = true; return texture;
}
