import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { COMPONENTS, GEOMETRY_SI as D, SPOOL_GEOMETRY as S, PORTS, CIRCUIT_ROUTES, cylinderGeometry, tankGeometry, spoolGeometry } from './geometry.js';
import { PUMP_DETAIL, RELIEF_DETAIL, reliefConeY, pumpHousingGeometry, pumpCoverGeometry, pumpGearGeometry, pumpRadialClearanceBound, reliefHousingGeometry, reliefSeatGeometry, reliefPoppetGeometry, engineeringFinish } from './mechanical-geometry.js';
import { hoseCurve, hosePressureBand, flowArrowGeometry } from './scene-hoses.js';
import './scene.css';

const TAU = Math.PI * 2;
const V = a => new THREE.Vector3(...a);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const ordinary = value => Object.is(value, -0) ? 0 : value;
const FLOW_THRESHOLD_M3S = 1e-12;
const ARROW_SPEED_MPS = .085;
const STAGE_COLOR = '#162633';
const DEFAULT_VIEW = { mode: 'cutaway', explode: .35, labels: true, layers: { housing: true, seals: true, paths: true }, selectedPart: 'piston', pressureColors: true, flowArrows: true };

// A closed annular sector along X: the inner wall and cut faces are real surfaces.
function sleeveGeometry(inner, outer, length, start = 0, sweep = TAU) {
  const positions = [], normals = [], segments = Math.max(20, Math.ceil(sweep / TAU * 80));
  const point = (x, r, a) => [x, r * Math.cos(a), r * Math.sin(a)];
  const quad = (a, b, c, d, reverse = false) => {
    const order = reverse ? [a, c, b, a, d, c] : [a, b, c, a, c, d];
    let normalVector = V(order[1]).sub(V(order[0])).cross(V(order[2]).sub(V(order[0])));
    if (normalVector.lengthSq() < 1e-24) normalVector = V(order[4]).sub(V(order[3])).cross(V(order[5]).sub(V(order[3])));
    const normal = normalVector.normalize().toArray();
    for (const p of order) { positions.push(...p); normals.push(...normal); }
  };
  for (let i = 0; i < segments; i++) {
    const a = start + sweep * i / segments, b = start + sweep * (i + 1) / segments;
    quad(point(-length / 2, outer, a), point(-length / 2, outer, b), point(length / 2, outer, b), point(length / 2, outer, a));
    if (inner > 0) quad(point(-length / 2, inner, a), point(length / 2, inner, a), point(length / 2, inner, b), point(-length / 2, inner, b));
    for (const side of [-1, 1]) quad(point(side * length / 2, inner, a), point(side * length / 2, inner, b), point(side * length / 2, outer, b), point(side * length / 2, outer, a), side < 0);
  }
  const surfaceVertexCount = positions.length / 3;
  if (sweep < TAU - 1e-9) for (const [a, reverse] of [[start, true], [start + sweep, false]]) quad(point(-length / 2, inner, a), point(-length / 2, outer, a), point(length / 2, outer, a), point(length / 2, inner, a), reverse);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  if (surfaceVertexCount < positions.length / 3) {
    geometry.addGroup(0, surfaceVertexCount, 0);
    geometry.addGroup(surfaceVertexCount, positions.length / 3 - surfaceVertexCount, 1);
  }
  return geometry;
}

// A drilled spool land, including the actual radial hole wall. At each X station,
// the opening is the intersection x²+z²=rHole² of a Y-axis drill and the sleeve.
// Both half sections share the same intersection; no opaque land crosses a drill.
function drilledSpoolSection(inner, outer, minX, maxX, front) {
  const positions = [], xs = [minX, maxX], holes = inner > 0 ? S.radialHoleCentersM.filter(x => x - S.radialHoleRadiusM > minX && x + S.radialHoleRadiusM < maxX) : [];
  for (const center of holes) for (let i = 0; i <= 24; i++) xs.push(center - S.radialHoleRadiusM * Math.cos(Math.PI * i / 24));
  xs.sort((a, b) => a - b);
  const quad = (a, b, c, d, reverse = false) => { for (const p of reverse ? [a, c, b, a, d, c] : [a, b, c, a, c, d]) positions.push(...p); };
  const opening = x => { const center = holes.find(center => Math.abs(x - center) <= S.radialHoleRadiusM + 1e-12); return center === undefined ? 0 : Math.sqrt(Math.max(0, S.radialHoleRadiusM ** 2 - (x - center) ** 2)); };
  const point = (x, radius, theta) => [x, radius * Math.cos(theta), radius * Math.sin(theta)];
  for (let xi = 1; xi < xs.length; xi++) {
    const a = xs[xi - 1], b = xs[xi]; if (b - a < 1e-12) continue;
    const za = opening(a), zb = opening(b), inHole = opening((a + b) / 2) > 0;
    for (const [radius, reverse] of [[outer, false], [inner, true]]) {
      if (radius === 0) continue;
      const cutA = Math.asin(clamp(za / radius, 0, 1)), cutB = Math.asin(clamp(zb / radius, 0, 1));
      for (let i = 0; i < 40; i++) {
        const angle = (cut, t) => front ? cut + (Math.PI - cut) * t : Math.PI + (Math.PI - cut) * t;
        quad(point(a, radius, angle(cutA, i / 40)), point(a, radius, angle(cutA, (i + 1) / 40)), point(b, radius, angle(cutB, (i + 1) / 40)), point(b, radius, angle(cutB, i / 40)), reverse);
      }
    }
    // The lower cut face always exists. A drill removes the upper face locally.
    quad([a, -outer, 0], [b, -outer, 0], [b, -inner, 0], [a, -inner, 0], front);
    if (!inHole) quad([a, inner, 0], [b, inner, 0], [b, outer, 0], [a, outer, 0], front);
    else {
      const sign = front ? 1 : -1;
      quad([a, Math.sqrt(inner ** 2 - za ** 2), sign * za], [a, Math.sqrt(outer ** 2 - za ** 2), sign * za], [b, Math.sqrt(outer ** 2 - zb ** 2), sign * zb], [b, Math.sqrt(inner ** 2 - zb ** 2), sign * zb], front);
    }
  }
  for (const x of [minX, maxX]) for (let i = 0; i < 40; i++) {
    const a = (front ? 0 : Math.PI) + Math.PI * i / 40, b = a + Math.PI / 40;
    quad(point(x, inner, a), point(x, inner, b), point(x, outer, b), point(x, outer, a), x === minX);
  }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.computeVertexNormals(); return geometry;
}

// One continuous path; rounding stays inside the adjacent segments and keeps fittings exact.
function roundedPath(points, radius = .016) {
  const path = new THREE.CurvePath(), p = points.map(V);
  let cursor = p[0];
  for (let i = 1; i < p.length - 1; i++) {
    const previous = p[i - 1], corner = p[i], next = p[i + 1];
    const amount = Math.min(radius, previous.distanceTo(corner) * .28, next.distanceTo(corner) * .28);
    const before = corner.clone().add(previous.clone().sub(corner).normalize().multiplyScalar(amount));
    const after = corner.clone().add(next.clone().sub(corner).normalize().multiplyScalar(amount));
    if (cursor.distanceTo(before) > 1e-8) path.add(new THREE.LineCurve3(cursor, before));
    path.add(new THREE.QuadraticBezierCurve3(before, corner, after)); cursor = after;
  }
  path.add(new THREE.LineCurve3(cursor, p.at(-1))); return path;
}

export class HydraulicScene {
  constructor(container, { onSelect = () => {}, onCameraChange = () => {} } = {}) {
    this.container = container; this.onSelect = onSelect; this.onCameraChange = onCameraChange;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.disposed = false; this.updating = false; this.view = structuredClone(DEFAULT_VIEW);
    this.components = new Map(); this.geometries = new Set(); this.materials = new Set(); this.textures = new Set(); this.housings = []; this.sealParts = []; this.routes = []; this.highlighted = [];
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(STAGE_COLOR);
    this.scene.fog = new THREE.Fog(STAGE_COLOR, 2.8, 7);
    this.camera = new THREE.PerspectiveCamera(37, 1, .003, 16);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.7));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace; this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.1;
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.setAttribute('aria-label', '복동 실린더와 방향밸브의 연결을 관찰하는 유압 시험대');
    this.renderer.domElement.setAttribute('tabindex', '0'); container.classList.add('hydraulic-scene'); container.append(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    // No damping means an exact camera restore, and no hidden animation loop while paused.
    this.controls.enableDamping = false; this.controls.minDistance = .20; this.controls.maxDistance = 4; this.controls.minPolarAngle = 0; this.controls.maxPolarAngle = Math.PI;
    this.controls.zoomSpeed = .7; this.controls.panSpeed = .65;
    this.controlChange = () => { if (!this.updating && !this.disposed) { this.render(); this.onCameraChange(this.getCameraState()); } };
    this.controls.addEventListener('change', this.controlChange);
    const environment = new RoomEnvironment(), pmrem = new THREE.PMREMGenerator(this.renderer);
    this.environment = pmrem.fromScene(environment, .025); this.scene.environment = this.environment.texture; this.scene.environmentIntensity = .9; environment.dispose(); pmrem.dispose();
    this.scene.add(new THREE.HemisphereLight(0xc9eaff, 0x233646, 1.2));
    const key = new THREE.DirectionalLight(0xffedcd, 3.6); key.position.set(.2, 1.5, .7); key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048); Object.assign(key.shadow.camera, { left: -.85, right: .85, top: .7, bottom: -.7, near: .1, far: 4 });
    key.shadow.bias = -.0002; key.shadow.normalBias = .0008; this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x8acbe8, 2.1); rim.position.set(-.6, .6, -.8); this.scene.add(rim);
    this.root = new THREE.Group(); this.scene.add(this.root); this.stage = new THREE.Group(); this.scene.add(this.stage);
    this.createMaterials(); this.buildCylinder(); this.buildValve(); this.buildPowerUnit(); this.buildRelief(); this.buildRoutes(); this.buildBench(); this.buildOverlay();
    this.root.traverse(node => {
      if (!node.isMesh) return;
      let parent = node; while (parent && !parent.userData.partId) parent = parent.parent;
      if (parent) node.userData.partId = parent.userData.partId;
    });
    this.raycaster = new THREE.Raycaster(); this.pointer = new THREE.Vector2();
    this.pointerDown = event => { this.down = { x: event.clientX, y: event.clientY, button: event.button }; };
    this.pointerUp = event => this.pick(event);
    this.renderer.domElement.addEventListener('pointerdown', this.pointerDown); this.renderer.domElement.addEventListener('pointerup', this.pointerUp);
    this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(container);
    this.applyView(); this.resize(); this.resetCamera();
  }

  material(properties) { const material = new THREE.MeshStandardMaterial(properties); this.materials.add(material); return material; }
  createMaterials() {
    const finish = kind => { const texture = engineeringFinish(kind); texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy()); this.textures.add(texture); return texture; };
    const cast = finish('cast'), turned = finish('turned');
    this.mat = {
      steel: this.material({ color: '#afc0ca', metalness: .94, roughness: .25, side: THREE.DoubleSide }),
      machined: this.material({ color: '#b2bdc2', metalness: .91, roughness: .3, bumpMap: turned, bumpScale: .000025, side: THREE.DoubleSide }),
      cutFace: this.material({ color: '#c3c9c9', metalness: .48, roughness: .47, side: THREE.DoubleSide }),
      chrome: this.material({ color: '#dce7ec', metalness: .98, roughness: .13, side: THREE.DoubleSide }),
      cast: this.material({ color: '#5d7787', metalness: .72, roughness: .48, bumpMap: cast, bumpScale: .00007, side: THREE.DoubleSide }),
      painted: this.material({ color: '#245265', metalness: .58, roughness: .4, side: THREE.DoubleSide }),
      barrelPaint: this.material({ color: '#9d6b30', metalness: .27, roughness: .5, bumpMap: cast, bumpScale: .000018, side: THREE.DoubleSide }),
      panel: this.material({ color: '#40505b', metalness: .45, roughness: .55 }),
      zinc: this.material({ color: '#b6b5a8', metalness: .73, roughness: .34, bumpMap: turned, bumpScale: .000025 }),
      dark: this.material({ color: '#263c49', metalness: .77, roughness: .34, side: THREE.DoubleSide }),
      brass: this.material({ color: '#c7a66a', metalness: .85, roughness: .28, side: THREE.DoubleSide }),
      seal: this.material({ color: '#285e68', metalness: .05, roughness: .6, side: THREE.DoubleSide }),
      rubber: this.material({ color: '#19282f', metalness: .08, roughness: .7, side: THREE.DoubleSide }),
      hose: this.material({ color: '#1e272b', roughness: .84, bumpMap: cast, bumpScale: .000045 }),
      filter: this.material({ color: '#d8bb86', metalness: .04, roughness: .8, side: THREE.DoubleSide }),
      oil: this.material({ color: '#ccab54', metalness: .08, roughness: .25, transparent: true, opacity: .35, depthWrite: false, side: THREE.DoubleSide }),
      transparent: this.material({ color: '#9bbdc8', metalness: .12, roughness: .35, transparent: true, opacity: .11, depthWrite: false, side: THREE.DoubleSide }),
    };
  }
  overlayMaterial(color) {
    const material = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, toneMapped: false });
    this.materials.add(material); return material;
  }
  mesh(geometry, material, parent, position) {
    this.geometries.add(geometry); const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = !material.transparent; mesh.receiveShadow = true;
    if (position) mesh.position.set(...position); parent.add(mesh); return mesh;
  }
  box(size, material, parent, position) { return this.mesh(new THREE.BoxGeometry(...size), material, parent, position); }
  plate(size, radius, material, parent, position) { return this.mesh(new RoundedBoxGeometry(...size, 2, radius), material, parent, position); }
  cylinder(radius, length, material, parent, position, axis = 'y', segments = 40) {
    const mesh = this.mesh(new THREE.CylinderGeometry(radius, radius, length, segments), material, parent, position);
    if (axis === 'x') mesh.rotation.z = -Math.PI / 2; else if (axis === 'z') mesh.rotation.x = Math.PI / 2; return mesh;
  }
  sleeve(inner, outer, length, material, parent, position, start = 0, sweep = TAU, axis = 'x') {
    const mesh = this.mesh(sleeveGeometry(inner, outer, length, start, sweep), material, parent, position);
    if (axis === 'y') mesh.rotation.z = Math.PI / 2; else if (axis === 'z') mesh.rotation.y = -Math.PI / 2; return mesh;
  }
  rodBetween(a, b, radius, material, parent, segments = 16) {
    const start = V(a), end = V(b), delta = end.clone().sub(start);
    const mesh = this.cylinder(radius, delta.length(), material, parent, start.clone().add(end).multiplyScalar(.5).toArray(), 'y', segments);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize()); return mesh;
  }
  tube(points, radius, material, parent, rounded = true) {
    const curve = rounded ? roundedPath(points) : new THREE.CatmullRomCurve3(points.map(V));
    return { mesh: this.mesh(new THREE.TubeGeometry(curve, Math.max(24, points.length * 12), radius, 10, false), material, parent), curve };
  }
  part(id, anchor, parent = this.root) {
    const description = COMPONENTS.find(part => part.id === id), node = new THREE.Group();
    node.name = id; node.userData.partId = id; parent.add(node);
    this.components.set(id, { ...description, node, anchor: V(anchor) }); return node;
  }
  bolt(parent, position, axis = 'y', scale = 1) {
    const head = this.cylinder(.0035 * scale, .003 * scale, this.mat.chrome, parent, position, axis, 6);
    return head;
  }
  housing(back, front, displacement = [0, 0, .16]) { this.housings.push({ back, front, displacement }); }
  splitSleeve(inner, outer, length, material, parent, position, displacement, axis = 'x') {
    const back = new THREE.Group(), front = new THREE.Group(); parent.add(back, front);
    const section = [material, this.mat.cutFace];
    this.sleeve(inner, outer, length, section, back, position, Math.PI, Math.PI, axis);
    this.sleeve(inner, outer, length, section, front, position, 0, Math.PI, axis);
    this.housing(back, front, displacement); return { back, front };
  }
  spring(parent, a, b, radius, turns = 9, wire = .0009) {
    const start = V(a), end = V(b), direction = end.clone().sub(start), length = direction.length();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), direction.normalize()), points = [];
    for (let i = 0; i <= turns * 20; i++) { const t = i / (turns * 20); points.push(new THREE.Vector3(length * t, radius * Math.cos(t * turns * TAU), radius * Math.sin(t * turns * TAU)).applyQuaternion(q).add(start).toArray()); }
    return this.tube(points, wire, this.mat.chrome, parent, false).mesh;
  }

  buildCylinder() {
    const m = this.mat, y = D.cylinderAxisY, c = cylinderGeometry(.15);
    this.barrel = this.part('cylinder-barrel', [-.14, y + .036, 0]);
    this.splitSleeve(D.boreRadiusM, D.barrelOuterRadiusM, D.barrelX[1] - D.barrelX[0], m.barrelPaint, this.barrel, [(D.barrelX[0] + D.barrelX[1]) / 2, y, 0], [0, .04, .21]);
    this.cap = this.part('cap-end', [-.29, y, 0]);
    this.cylinder(.041, .020, m.cast, this.cap, [-.29, y, 0], 'x');
    this.cylinder(.025, .006, m.steel, this.cap, [-.303, y, 0], 'x');
    this.gland = this.part('rod-gland', [.061, y, 0]);
    this.splitSleeve(.024, .041, .022, m.cast, this.gland, [.061, y, 0], [0, .04, .14]);
    for (const x of [-.304, .074]) for (let i = 0; i < 6; i++) { const a = i * TAU / 6; this.bolt(x < 0 ? this.cap : this.gland, [x, y + .035 * Math.cos(a), .035 * Math.sin(a)], 'x'); }
    // The body is supported by saddles bolted into the common test bench.
    for (const x of [-.258, .020]) {
      this.plate([.045, .178, .060], .003, m.dark, this.barrel, [x, .116, -.036]);
      this.sleeve(.036, .043, .026, m.cast, this.barrel, [x, y, 0], Math.PI / 2, Math.PI);
      this.plate([.073, .010, .105], .002, m.zinc, this.barrel, [x, .025, -.008]);
      for (const offset of [-.024, .024]) for (const z of [-.048, .034]) {
        this.cylinder(.005, .0014, m.steel, this.barrel, [x + offset, .030, z], 'y', 16);
        this.bolt(this.barrel, [x + offset, .032, z]);
      }
    }
    this.piston = this.part('piston', [0, 0, .028]);
    this.cylinder(.0296, .018, m.steel, this.piston, [0, 0, 0], 'x');
    for (const x of [-.0063, .0063]) this.sleeve(.0284, .0299, .0018, m.brass, this.piston, [x, 0, 0]);
    this.pistonSeal = this.part('piston-seal', [0, .030, 0], this.piston);
    this.sleeve(.0288, .030, .004, m.seal, this.pistonSeal, [0, 0, 0]); this.sealParts.push(this.pistonSeal);
    this.rod = this.part('rod', [.12, y, .018]);
    this.rodMesh = this.cylinder(c.rod.radiusM, c.rod.lengthM, m.chrome, this.rod, [0, y, 0], 'x');
    this.rodSeals = [];
    for (const [id, key, material] of [['rod-guide', 'guide', m.brass], ['rod-seal', 'rod', m.seal], ['wiper', 'wiper', m.rubber]]) {
      const spec = c.seals[key], group = this.part(id, spec.center);
      this.sleeve(spec.innerRadiusM, spec.outerRadiusM, spec.widthM, material, group, spec.center);
      this.rodSeals.push(group); this.sealParts.push(group);
    }
    // Oil and the physical bore meet at exactly 30 mm. Bias only raster depth
    // behind the metal contact surface; preserve real radii, volumes and occlusion.
    this.capFluidMat = this.material({ color: '#3b9ec3', transparent: true, opacity: .35, metalness: .02, roughness: .4, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    this.rodFluidMat = this.capFluidMat.clone(); this.materials.add(this.rodFluidMat);
    this.capFluid = this.sleeve(0, D.boreRadiusM, 1, this.capFluidMat, this.barrel, [0, y, 0]);
    this.rodFluid = this.sleeve(D.rodRadiusM, D.boreRadiusM, 1, this.rodFluidMat, this.barrel, [0, y, 0]);
    this.capFluid.userData.section = { innerRadiusM: 0, outerRadiusM: D.boreRadiusM, baseLengthM: 1 };
    this.rodFluid.userData.section = { innerRadiusM: D.rodRadiusM, outerRadiusM: D.boreRadiusM, baseLengthM: 1 };
    this.capFluid.userData.nonPickable = true; this.rodFluid.userData.nonPickable = true;
    this.carriage = this.part('load-carriage', [0, .235, 0]);
    this.plate([.064, .050, .088], .004, m.cast, this.carriage, [0, .183, 0]);
    this.plate([.012, .065, .062], .002, m.zinc, this.carriage, [0, .220, 0]);
    for (const x of [-.022, .022]) for (const z of [-.033, .033]) this.bolt(this.carriage, [x, .209, z], 'y', .82);
    // A fork, cross pin, and eye join the chrome rod to the translating carriage.
    for (const z of [-.016, .016]) this.box([.040, .035, .009], m.steel, this.carriage, [-.020, y, z]);
    this.sleeve(.006, .015, .017, m.chrome, this.carriage, [-.040, y, 0], 0, TAU, 'z');
    this.cylinder(.006, .049, m.dark, this.carriage, [-.040, y, 0], 'z');
    for (const z of [-.026, .026]) this.bolt(this.carriage, [-.040, y, z], 'z');
    this.loadGuide = this.part('load-guide', [.34, .147, -.047]);
    for (const z of [-.032, .032]) {
      this.cylinder(.009, .445, m.chrome, this.loadGuide, [.303, .151, z], 'x');
      for (const x of [.090, .516]) {
        this.plate([.026, .132, .038], .002, m.dark, this.loadGuide, [x, .084, z]);
        this.plate([.027, .027, .040], .002, m.zinc, this.loadGuide, [x, .148, z]);
        this.bolt(this.loadGuide, [x, .163, z]);
      }
      this.sleeve(.0092, .014, .060, m.brass, this.carriage, [0, .151, z]);
    }
    this.plate([.466, .013, .116], .002, m.panel, this.loadGuide, [.303, .022, 0]);
    for (const z of [-.051, .051]) this.box([.444, .002, .004], m.zinc, this.loadGuide, [.303, .027, z]);
    this.box([.014, .04, .055], m.dark, this.loadGuide, [.514, .195, 0]);
    // A fixed horizontal friction track identifies a resisting test load, not a hanging weight.
    this.box([.440, .014, .018], m.brass, this.loadGuide, [.303, .184, -.063]);
    this.box([.039, .026, .028], m.dark, this.carriage, [0, .184, -.059]);
    this.updateCylinder(c);
  }

  buildValve() {
    const m = this.mat, center = D.valveCenter;
    this.valve = this.part('directional-body', center); this.valve.position.set(...center); this.components.get('directional-body').anchor.set(0, .027, 0);
    const back = new THREE.Group(), front = new THREE.Group(); this.valve.add(back, front);
    // Flat top/bottom ribs join the actual bored rear half; the removable front is separate.
    const bodySplits = [-.080, ...S.bodyWindows.flatMap(w => [w.minX, w.maxX]), .080];
    const section = [m.cast, m.cutFace];
    for (let index = 1; index < bodySplits.length; index++) {
      const a = bodySplits[index - 1], b = bodySplits[index], mid = (a + b) / 2;
      const gallery = S.bodyWindows.some(w => mid > w.minX && mid < w.maxX), inner = gallery ? .0135 : .009;
      this.sleeve(inner, .028, b - a, section, back, [mid, 0, 0], Math.PI, Math.PI);
      this.sleeve(inner, .028, b - a, section, front, [mid, 0, 0], 0, Math.PI);
    }
    for (const side of [-1, 1]) {
      this.box([.174, .008, .048], m.cast, back, [0, side * .032, -.011]);
      for (const x of [-.068, .068]) this.bolt(back, [x, side * .037, -.016]);
    }
    this.plate([.172, .060, .015], .0024, m.painted, back, [0, 0, -.029]);
    for (const x of [-.074, .074]) {
      this.plate([.016, .054, .051], .002, m.zinc, front, [x, 0, .015]);
      for (const y of [-.018, .018]) this.bolt(front, [x, y, .041], 'z', .82);
    }
    this.housing(back, front, [0, .035, .15]);
    this.plate([.206, .015, .100], .003, m.panel, this.valve, [0, -.070, -.009]);
    for (const x of [-.086, .086]) for (const z of [-.044, .026]) {
      this.cylinder(.0052, .0015, m.steel, this.valve, [x, -.062, z], 'y', 16);
      this.bolt(this.valve, [x, -.0595, z], 'y', .86);
    }
    for (const x of [-.064, .064]) this.plate([.024, .035, .039], .002, m.cast, this.valve, [x, -.048, -.022]);
    this.windowMaterials = {}; this.galleryFluids = [];
    // Galleries are wider than the spool bore; each visible rear annulus is connected by drilling.
    for (const w of S.bodyWindows) {
      const material = this.material({ color: '#479fb6', metalness: .22, roughness: .4, transparent: true, opacity: .65, side: THREE.DoubleSide });
      this.windowMaterials[w.id] = material;
      this.sleeve(.0130, .0135, w.maxX - w.minX, m.brass, back, [w.centerX, 0, 0], Math.PI, Math.PI);
      this.galleryFluids.push(this.sleeve(.0090, .0129, w.maxX - w.minX, material, this.valve, [w.centerX, 0, 0], Math.PI, Math.PI));
    }
    this.valvePaths = new THREE.Group(); this.valve.add(this.valvePaths);
    this.internalPorts = [];
    for (const [port, x, endpoint] of [['P', 0, [0, -.04, 0]], ['A', -.02, [-.02, .04, 0]], ['B', .02, [.02, .04, 0]]]) {
      const part = this.part(`port-${port}`, [x, port === 'P' ? -.032 : .032, .008], this.valve);
      const y = port === 'P' ? -.011 : .011;
      const material = this.material({ color: '#4cbed0', emissive: '#19485a', emissiveIntensity: .3, roughness: .4 });
      const path = this.tube([[x, y, 0], endpoint], .0024, material, part); this.internalPorts.push({ port, material, node: part, meshes: [path.mesh] });
      this.sleeve(.0034, .0068, .012, m.brass, part, [x, endpoint[1] + (port === 'P' ? .006 : -.006), 0], 0, TAU, 'y');
    }
    const t = this.part('port-T', [0, 0, .039], this.valve);
    const tmat = this.material({ color: '#4cbed0', emissive: '#19485a', emissiveIntensity: .3, roughness: .4 });
    const t1 = this.tube([[-.04, 0, -.011], [-.04, -.018, -.026], [.04, -.018, -.026], [.04, 0, -.011]], .0024, tmat, t);
    const t2 = this.tube([[0, -.018, -.026], [0, -.021, .025], [0, 0, .0475]], .0024, tmat, t);
    this.internalPorts.push({ port: 'T', material: tmat, node: t, meshes: [t1.mesh, t2.mesh] });
    this.spool = this.part('directional-spool', [0, 0, .010], this.valve);
    this.spoolBack = new THREE.Group(); this.spoolFront = new THREE.Group(); this.spool.add(this.spoolBack, this.spoolFront);
    const initial = spoolGeometry('neutral');
    // The hollow neutral bypass is a through gallery with closed axial ends.
    for (const section of [...initial.lands, ...initial.grooves]) {
      const splits = [...new Set([section.minX, section.maxX, ...S.axialBoreX.filter(x => x > section.minX && x < section.maxX)])].sort((a, b) => a - b);
      for (let i = 1; i < splits.length; i++) {
        const a = splits[i - 1], b = splits[i], mid = (a + b) / 2, inner = mid >= S.axialBoreX[0] && mid <= S.axialBoreX[1] ? S.axialBoreRadiusM : 0;
        this.mesh(drilledSpoolSection(inner, section.radiusM, a, b, false), m.chrome, this.spoolBack);
        this.mesh(drilledSpoolSection(inner, section.radiusM, a, b, true), m.chrome, this.spoolFront);
      }
    }
    this.bypass = new THREE.Group(); this.spool.add(this.bypass);
    this.bypassMaterial = this.material({ color: '#71d9de', emissive: '#327c91', emissiveIntensity: .4, roughness: .3 });
    this.cylinder(.0017, .096, this.bypassMaterial, this.bypass, [0, 0, 0], 'x', 16);
    // The half section shows each radial drilling from the axial gallery to the top of a land.
    this.radialDrills = [];
    for (const x of S.radialHoleCentersM) {
      const hole = this.cylinder(.0013, .007, this.bypassMaterial, this.bypass, [x, .0053, 0], 'y', 14); this.radialDrills.push(hole);
    }
    this.neutralArrows = new THREE.Group(); this.bypass.add(this.neutralArrows);
    const bypassArrow = flowArrowGeometry(.61), bypassArrowMaterial = this.overlayMaterial('#eafaff');
    for (const sign of [-1, 1]) {
      const arrow = this.mesh(bypassArrow, bypassArrowMaterial, this.neutralArrows, [sign * .023, 0, .004]);
      arrow.rotation.z = sign < 0 ? Math.PI : 0;
      arrow.castShadow = false; arrow.receiveShadow = false; arrow.userData.nonPickable = true;
    }
    this.spoolStem = this.cylinder(.004, .052, m.chrome, this.spool, [.079, 0, 0], 'x');
    this.cylinder(.012, .008, m.dark, this.spool, [.104, 0, 0], 'x');
    this.springs = this.part('centering-springs', [.070, 0, 0], this.valve);
    this.leftSpring = this.spring(this.springs, [-.098, 0, 0], [-.066, 0, 0], .007, 8);
    this.rightSpring = this.spring(this.springs, [.066, 0, 0], [.098, 0, 0], .007, 8);
    for (const x of [-.100, .100]) this.sleeve(.0045, .012, .003, m.steel, this.springs, [x, 0, 0]);
  }

  buildPowerUnit() {
    const m = this.mat, { min, max } = D.tankInsideBounds;
    const cx = (min[0] + max[0]) / 2, cy = (min[1] + max[1]) / 2, cz = (min[2] + max[2]) / 2;
    const width = max[0] - min[0], height = max[1] - min[1], depth = max[2] - min[2];
    this.tank = this.part('tank', [cx, max[1], cz]); const back = new THREE.Group(), front = new THREE.Group(); this.tank.add(back, front);
    this.box([width + .008, .005, depth + .008], m.painted, back, [cx, min[1] - .0025, cz]);
    this.box([width, height, .004], m.painted, back, [cx, cy, min[2] - .002]);
    this.box([.004, height, depth], m.painted, back, [min[0] - .002, cy, cz]);
    this.box([.004, height, depth], m.painted, back, [max[0] + .002, cy, cz]);
    this.box([width + .008, height, .004], m.painted, front, [cx, cy, max[2] + .002]);
    this.tankLid = this.box([width + .016, .006, depth + .016], m.cast, front, [cx, max[1] + .003, cz]);
    this.cylinder(.013, .013, m.dark, front, [cx - .07, max[1] + .013, cz]);
    this.cylinder(.016, .007, m.zinc, front, [cx - .07, max[1] + .023, cz], 'y', 20);
    for (const x of [cx - .079, cx + .079]) {
      this.plate([.026, .004, .023], .001, m.dark, front, [x, max[1] + .008, cz - .069]);
      this.sleeve(.006, .009, .004, m.zinc, front, [x, max[1] + .015, cz - .069], 0, TAU, 'z');
    }
    for (const x of [min[0], max[0]]) for (const z of [min[2], max[2]]) this.bolt(front, [x, max[1] + .008, z]);
    this.housing(back, front, [0, .045, .21]);
    // Scale marks remain on a narrow rear post, leaving a broad unobstructed oil window.
    for (let index = 1; index <= 6; index++) this.box([.013, .0007, .001], m.brass, back, [min[0] + .014, min[1] + index * .001 / (width * depth), min[2] + .003]);
    this.tankOil = this.part('tank-oil', [cx + .045, .126, cz]);
    this.tankFluid = this.box([width, 1, depth], m.oil, this.tankOil, [cx, cy, cz]); this.tankFluid.scale.y = height;
    this.strainer = this.part('suction-strainer', [-.4, .04, .16]);
    this.sleeve(.012, .014, .045, m.dark, this.strainer, [-.4, .04, .18], 0, TAU, 'z');
    for (let index = 0; index < 10; index++) this.sleeve(.014, .0144, .0006, m.steel, this.strainer, [-.4, .04, .16 + index * .0045], 0, TAU, 'z');
    for (let i = 0; i < 12; i++) { const a = i * TAU / 12; this.rodBetween([-.4 + .014 * Math.cos(a), .04 + .014 * Math.sin(a), .157], [-.4 + .014 * Math.cos(a), .04 + .014 * Math.sin(a), .204], .00035, m.steel, this.strainer, 5); }
    this.pump = this.part('pump', D.pumpCenter);
    const pumpBack = new THREE.Group(), pumpFront = new THREE.Group(); this.pump.add(pumpBack, pumpFront);
    this.pumpHousingMesh = this.mesh(pumpHousingGeometry(), [m.machined, m.cast], pumpBack, D.pumpCenter);
    this.pumpCovers = [];
    for (const sign of [-1, 1]) {
      const parent = sign < 0 ? pumpBack : pumpFront;
      const z = D.pumpCenter[2] + sign * (PUMP_DETAIL.bodyHalfWidthM + PUMP_DETAIL.coverThicknessM / 2);
      const cover = this.mesh(pumpCoverGeometry(), [m.machined, m.cast], parent, [D.pumpCenter[0], D.pumpCenter[1], z]); this.pumpCovers.push(cover);
      for (const x of PUMP_DETAIL.gearCentersX) this.sleeve(PUMP_DETAIL.journalInnerRadiusM, PUMP_DETAIL.journalOuterRadiusM, PUMP_DETAIL.coverThicknessM, m.brass, parent, [D.pumpCenter[0] + x, D.pumpCenter[1], z], 0, TAU, 'z');
    }
    for (const [x, y] of PUMP_DETAIL.bolts) {
      const point = [D.pumpCenter[0] + x, D.pumpCenter[1] + y, D.pumpCenter[2]];
      this.cylinder(PUMP_DETAIL.boltRadiusM, .028, m.dark, pumpFront, point, 'z', 20);
      this.bolt(pumpFront, [point[0], point[1], point[2] + .0141], 'z', .8);
    }
    this.housing(pumpBack, pumpFront, [0, .02, .12]);
    this.pumpGears = new THREE.Group(); this.pump.add(this.pumpGears);
    this.pumpGearMeshes = [];
    for (const x of PUMP_DETAIL.gearCentersX) {
      const gear = new THREE.Group(); gear.position.set(D.pumpCenter[0] + x, D.pumpCenter[1], D.pumpCenter[2]); this.pumpGears.add(gear);
      this.pumpGearMeshes.push(this.mesh(pumpGearGeometry(), [m.machined, m.steel], gear));
      this.cylinder(PUMP_DETAIL.shaftRadiusM, .047, m.chrome, gear, [0, 0, -.008], 'z');
    }
    this.pumpGears.children[1].rotation.z = Math.PI / 12;
    this.pumpClearance = pumpRadialClearanceBound(this.pumpGearMeshes[0].geometry);
    this.plate([.069, .065, .051], .004, m.dark, this.pump, [-.36, .066, -.10]);
    this.plate([.105, .010, .106], .002, m.zinc, this.pump, [-.36, .024, -.105]);
    for (const x of [-.40, -.32]) for (const z of [-.140, -.069]) this.bolt(this.pump, [x, .031, z]);
    const flangeZ = D.pumpCenter[2] - PUMP_DETAIL.bodyHalfWidthM - PUMP_DETAIL.coverThicknessM;
    this.cylinder(.014, .008, m.zinc, pumpBack, [-.375, .115, flangeZ - .004], 'z', 24);
    this.drive = this.part('pump-drive', [-.375, .115, -.19]);
    this.cylinder(.028, .074, m.painted, this.drive, [-.375, .115, -.188], 'z');
    for (let i = 0; i < 16; i++) {
      const azimuth = i * TAU / 16, y = .115 + .030 * Math.sin(azimuth), x = -.375 + .030 * Math.cos(azimuth);
      this.plate([.008, .0018, .063], .0006, m.painted, this.drive, [x, y, -.189]).rotation.z = azimuth;
    }
    for (const z of [-.226, -.151]) this.cylinder(.032, .009, m.cast, this.drive, [-.375, .115, z], 'z');
    this.cylinder(.025, .011, m.painted, this.drive, [-.375, .115, -.234], 'z');
    this.cylinder(.012, .031, m.dark, this.drive, [-.375, .115, -.131], 'z');
    for (const z of [-.141, -.120]) this.sleeve(.0118, .0134, .0025, m.zinc, this.drive, [-.375, .115, z], 0, TAU, 'z');
    this.plate([.038, .016, .035], .002, m.painted, this.drive, [-.375, .153, -.192]);
    this.plate([.041, .0045, .039], .0015, m.cast, this.drive, [-.375, .163, -.192]);
    for (const x of [-.390, -.36]) for (const z of [-.205, -.179]) this.bolt(this.drive, [x, .166, z], 'y', .53);
    for (const x of [-.398, -.352]) {
      this.plate([.017, .060, .047], .002, m.dark, this.drive, [x, .053, -.185]);
      this.plate([.026, .007, .057], .0016, m.cast, this.drive, [x, .024, -.185]);
      this.bolt(this.drive, [x, .029, -.208], 'y', .86);
    }
    this.filter = this.part('return-filter', D.filterCenter);
    this.splitSleeve(.018, .024, .065, m.cast, this.filter, [.045, .092, .20], [0, 0, .10], 'y');
    this.cylinder(.026, .012, m.steel, this.filter, [.045, .130, .2]);
    this.cylinder(.024, .006, m.steel, this.filter, [.045, .057, .2]);
    for (let i = 0; i < 30; i++) { const a = i * TAU / 30; const leaf = this.box([.0008, .057, .006], m.filter, this.filter, [.045 + .014 * Math.cos(a), .092, .2 + .014 * Math.sin(a)]); leaf.rotation.y = -a; }
    this.sleeve(.005, .007, .058, m.dark, this.filter, [.045, .092, .2], 0, TAU, 'y');
    this.box([.040, .025, .024], m.dark, this.filter, [.045, .037, .2]);
    this.box([.070, .010, .060], m.cast, this.filter, [.045, .020, .2]);
  }

  buildRelief() {
    const m = this.mat, p = D.reliefCenter;
    this.relief = this.part('relief-body', p);
    const back = new THREE.Group(), front = new THREE.Group(); this.relief.add(back, front);
    this.mesh(reliefHousingGeometry(), [m.cast, m.machined], back, p);
    this.mesh(reliefHousingGeometry(true), [m.cast, m.machined], front, p); this.housing(back, front, [0, 0, .11]);
    this.reliefSeatBack = new THREE.Group(); this.reliefSeatFront = new THREE.Group(); this.relief.add(this.reliefSeatBack, this.reliefSeatFront);
    this.reliefSeatMesh = this.mesh(reliefSeatGeometry(false), m.brass, this.reliefSeatBack, p);
    this.mesh(reliefSeatGeometry(true), m.brass, this.reliefSeatFront, p);
    this.poppet = this.part('relief-poppet', [p[0], p[1] - .018, p[2]]);
    this.poppetMesh = this.mesh(reliefPoppetGeometry(), m.chrome, this.poppet, p);
    this.cylinder(.003, .022, m.chrome, this.poppet, [p[0], p[1] - .002, p[2]]);
    this.cylinder(.0072, .0016, m.steel, this.poppet, [p[0], p[1] - .0036, p[2]]);
    this.reliefSpring = this.part('relief-spring', [p[0], p[1] + .008, p[2]]);
    this.reliefSpringMesh = this.spring(this.reliefSpring, [p[0], p[1] + RELIEF_DETAIL.springBottomY, p[2]], [p[0], p[1] + RELIEF_DETAIL.springTopY, p[2]], .0065, 10, .0008);
    this.adjuster = this.part('relief-adjuster', [p[0], p[1] + .043, p[2]]);
    this.cylinder(.008, .022, m.steel, this.adjuster, [p[0], p[1] + .034, p[2]]);
    for (let i = 0; i < 9; i++) this.sleeve(.0075, .0087, .0008, m.dark, this.adjuster, [p[0], p[1] + .024 + i * .0022, p[2]], 0, TAU, 'y');
    this.cylinder(.013, .006, m.dark, this.adjuster, [p[0], p[1] + .047, p[2]], 'y', 6);
    this.reliefPath = new THREE.Group(); this.relief.add(this.reliefPath);
    this.reliefMaterials = ['P', 'T'].map(() => this.material({ color: '#73d7dc', emissive: '#36828a', emissiveIntensity: .5, roughness: .3 }));
    const seat = [p[0] + .005, p[1] + reliefConeY(.005) + RELIEF_DETAIL.displayLiftM / 2, p[2]];
    this.tube([[p[0], .1275, p[2]], [p[0], p[1] + RELIEF_DETAIL.tipY - .002, p[2]], seat], .00055, this.reliefMaterials[0], this.reliefPath);
    this.tube([seat, [p[0] + .0081, p[1] - .0094, p[2]], [p[0] + .0081, .158, p[2]], [p[0] + .016, .158, p[2]]], .00055, this.reliefMaterials[1], this.reliefPath);
    this.box([.018, .087, .018], m.dark, this.relief, [p[0] - .025, .064, p[2]]);
    this.box([.070, .010, .045], m.cast, this.relief, [p[0], .018, p[2]]);
  }

  buildRoutes() {
    const m = this.mat;
    const arrowShape = flowArrowGeometry(1), arrowFill = this.overlayMaterial('#ffffff'), arrowEdge = this.overlayMaterial('#07131d');
    for (const id of ['line-suction', 'line-P', 'line-A', 'line-B', 'line-T', 'line-relief']) {
      const route = CIRCUIT_ROUTES.find(item => item.partId === id);
      this.part(id, route.points[Math.floor(route.points.length / 2)]);
    }
    for (const route of CIRCUIT_ROUTES) {
      const parent = this.components.get(route.partId).node;
      const rigid = ['pickup', 'relief-supply'].includes(route.id);
      const radius = route.partId === 'line-suction' ? .0075 : rigid ? .0039 : .0061;
      const curve = rigid ? roundedPath(route.points, .009) : hoseCurve(route, PORTS);
      const length = curve.getLength(), segments = Math.max(36, Math.ceil(length / .005));
      this.mesh(new THREE.TubeGeometry(curve, segments, radius, 14, false), rigid ? m.zinc : m.hose, parent);
      const edge = Math.min((rigid ? .008 : .025) / length, .31);
      const restriction = route.id === 'valve-return' ? .57 : null;
      const band = (from, to) => {
        const material = this.overlayMaterial('#67d8e8');
        const mesh = this.mesh(hosePressureBand(curve, radius + .00027, segments, from, to), material, parent);
        mesh.castShadow = false; mesh.receiveShadow = false; mesh.userData.nonPickable = true;
        return { material, mesh };
      };
      const cartridgeHalf = .009 / length;
      const bands = restriction ? [band(edge, restriction - cartridgeHalf), band(restriction + cartridgeHalf, 1 - edge)] : [band(edge, 1 - edge)];
      const arrows = [];
      for (let index = 0; index < Math.max(1, Math.ceil(length / .083)); index++) {
        const arrow = new THREE.Group(); arrow.visible = false; parent.add(arrow);
        const edge = this.mesh(arrowShape, arrowEdge, arrow), fill = this.mesh(arrowShape, arrowFill, arrow, [0, 0, .00018]);
        edge.scale.set(1.2, 1.32, 1);
        for (const mesh of [edge, fill]) { mesh.castShadow = false; mesh.receiveShadow = false; mesh.userData.nonPickable = true; }
        arrow.userData.baseScale = rigid && length < .08 ? .82 : 1.22;
        arrows.push(arrow);
      }
      for (const [id, progress, side] of [[route.from, 0, 1], [route.to, 1, -1]]) {
        const fitting = new THREE.Group(), point = curve.getPointAt(progress);
        fitting.position.copy(point);
        fitting.quaternion.setFromUnitVectors(V([1, 0, 0]), curve.getTangentAt(progress).multiplyScalar(side));
        this.components.get(PORTS[id].partId).node.attach(fitting);
        this.buildHoseFitting(fitting, radius, rigid);
      }
      if (restriction) {
        const cartridge = new THREE.Group(); parent.add(cartridge);
        cartridge.position.copy(curve.getPointAt(restriction));
        cartridge.quaternion.setFromUnitVectors(V([1, 0, 0]), curve.getTangentAt(restriction));
        this.cylinder(.009, .016, m.zinc, cartridge, [0, 0, 0], 'x', 6);
        this.cylinder(.0075, .004, m.dark, cartridge, [0, 0, 0], 'x', 24);
      }
      this.routes.push({ ...route, curve, length, radius, bands, arrows, flowM3s: 0, pressurePa: 0 });
    }
    for (const id of ['supply-tee', 'return-tee']) {
      const port = PORTS[id];
      this.plate([.020, .018, .020], .002, m.zinc, this.components.get(port.partId).node, port.position);
    }
  }

  buildHoseFitting(fitting, radius, rigid) {
    const m = this.mat;
    this.cylinder(radius + .004, .007, m.zinc, fitting, [.002, 0, 0], 'x', 6);
    this.cylinder(radius + .0018, .0075, m.steel, fitting, [.007, 0, 0], 'x', 20);
    if (rigid) return;
    this.cylinder(radius + .0021, .0135, m.machined, fitting, [.017, 0, 0], 'x', 24);
    for (const x of [.0125, .017, .0215]) this.cylinder(radius + .0024, .0016, m.zinc, fitting, [x, 0, 0], 'x', 24);
    this.cylinder(radius + .0011, .004, m.hose, fitting, [.024, 0, 0], 'x', 20);
  }

  buildBench() {
    const m = this.mat;
    this.plate([1.17, .029, .64], .006, m.dark, this.stage, [0, -.004, .060]);
    this.plate([1.19, .008, .66], .003, m.panel, this.stage, [0, .011, .060]);
    // Replaceable mounting decks sit directly under their respective assemblies.
    for (const [x, z, width, depth] of [[-.397, .040, .269, .564], [-.109, .124, .247, .191], [.317, 0, .536, .142]]) {
      this.plate([width, .0045, depth], .002, m.zinc, this.stage, [x, .017, z]);
      for (const dx of [-1, 1]) for (const dz of [-1, 1]) this.bolt(this.stage, [x + dx * (width / 2 - .012), .020, z + dz * (depth / 2 - .014)], 'y', .75);
    }
    this.plate([.247, .0045, .125], .002, m.zinc, this.stage, [-.171, .017, -.041]);
    for (const z of [-.256, .375]) {
      this.plate([1.123, .012, .0045], .0018, m.panel, this.stage, [0, -.004, z]);
      for (const x of [-.491, -.245, 0, .245, .491]) this.bolt(this.stage, [x, -.004, z + Math.sign(z) * .003], 'z', .62);
    }
    for (const x of [-.55, .55]) for (const z of [-.225, .345]) {
      this.plate([.041, .011, .033], .003, m.rubber, this.stage, [x, -.054, z]);
      this.cylinder(.012, .027, m.dark, this.stage, [x, -.034, z], 'y', 20);
      this.cylinder(.014, .006, m.zinc, this.stage, [x, -.021, z], 'y', 6);
      this.bolt(this.stage, [x, .016, z]);
    }
    this.buildFloor();
  }

  radialTexture(stops) {
    const canvas = document.createElement('canvas'), size = 256;
    canvas.width = canvas.height = size;
    const context = canvas.getContext('2d'), center = size / 2;
    const gradient = context.createRadialGradient(center, center, 0, center, center, center);
    for (const [offset, color] of stops) gradient.addColorStop(offset, color);
    context.fillStyle = gradient; context.fillRect(0, 0, size, size);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace; this.textures.add(texture);
    return texture;
  }

  buildFloor() {
    const floorY = -.060;
    const floor = new THREE.MeshBasicMaterial({
      map: this.radialTexture([[0, '#3d5260'], [.34, '#2e414f'], [1, STAGE_COLOR]]),
      toneMapped: false,
    });
    const contact = new THREE.MeshBasicMaterial({
      map: this.radialTexture([[0, '#050d17ba'], [.48, '#050d178a'], [1, '#050d1700']]),
      transparent: true, depthWrite: false, toneMapped: false,
    });
    const shadow = new THREE.ShadowMaterial({ opacity: .25, depthWrite: false });
    for (const material of [floor, contact, shadow]) this.materials.add(material);
    const ground = this.mesh(new THREE.PlaneGeometry(8, 8), floor, this.stage, [0, floorY, 0]);
    const contactShadow = this.mesh(new THREE.PlaneGeometry(1.72, 1.08), contact, this.stage, [0, floorY + .0001, .06]);
    const castShadow = this.mesh(new THREE.PlaneGeometry(3, 3), shadow, this.stage, [0, floorY + .0002, 0]);
    for (const plane of [ground, contactShadow, castShadow]) {
      plane.rotation.x = -Math.PI / 2; plane.castShadow = false;
    }
    ground.receiveShadow = contactShadow.receiveShadow = false;
  }

  buildOverlay() {
    this.overlay = document.createElement('div'); this.overlay.className = 'hydraulic-label-layer'; this.container.append(this.overlay);
    this.lines = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); this.lines.classList.add('hydraulic-label-lines'); this.overlay.append(this.lines);
    this.labels = new Map();
    for (const component of COMPONENTS) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'hydraulic-part-label'; button.textContent = component.name; button.dataset.partId = component.id;
      button.title = component.name;
      button.setAttribute('aria-label', `${component.name} 선택`); button.addEventListener('click', () => this.select(component.id)); this.overlay.append(button);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'path'); this.lines.append(line); this.labels.set(component.id, { button, line });
    }
    this.note = document.createElement('div'); this.note.className = 'hydraulic-scene-note'; this.note.hidden = true; this.overlay.append(this.note);
  }

  updateCylinder(c) {
    this.piston.position.set(...c.piston.center);
    this.rodMesh.position.x = (c.rod.start[0] + c.rod.end[0]) / 2;
    this.components.get('rod').anchor.x = (c.rod.end[0] + D.glandInsideX) / 2;
    this.carriage.position.x = c.loadCarriage[0];
    for (const [mesh, fluid] of [[this.capFluid, c.capFluid], [this.rodFluid, c.rodFluid]]) { mesh.scale.x = fluid.lengthM; mesh.position.set(...fluid.center); }
    this.drawnCylinder = c;
  }

  pressureColor(value) {
    // Fixed 0–100 bar scale; pressure never determines the arrow speed.
    const t = clamp(value / 1e7, 0, 1), low = [103, 216, 232], high = [255, 197, 109];
    const rgb = low.map((v, i) => Math.round(v + (high[i] - v) * t));
    return new THREE.Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
  }

  update(snapshot, view, { command = 'neutral', timeS = 0, elapsedS = 0 } = {}) {
    if (this.disposed || !snapshot) return;
    this.updating = true;
    this.snapshot = snapshot; this.command = command; this.timeS = timeS; this.elapsedS = elapsedS;
    this.view = { ...DEFAULT_VIEW, ...view, layers: { ...DEFAULT_VIEW.layers, ...view?.layers } };
    this.updateCylinder(cylinderGeometry(snapshot.positionM));
    const tank = tankGeometry(snapshot.volumesM3.tank);
    this.tankFluid.scale.y = tank.surfaceY - tank.bounds.min[1]; this.tankFluid.position.y = (tank.surfaceY + tank.bounds.min[1]) / 2; this.drawnTank = tank;
    const spool = spoolGeometry(command); this.spool.position.x = spool.offsetM; this.drawnSpool = spool;
    const explode = this.view.mode === 'exploded' ? this.view.explode : 0;
    this.leftSpring.scale.x = 1 + spool.offsetM / .032; this.leftSpring.position.x = .098 * spool.offsetM / .032;
    this.rightSpring.scale.x = 1 - spool.offsetM / .032; this.rightSpring.position.x = .098 * spool.offsetM / .032;
    const open = Math.abs(snapshot.flowsM3s.reliefToTank) > FLOW_THRESHOLD_M3S;
    this.poppet.position.y = open ? RELIEF_DETAIL.displayLiftM : 0;
    this.reliefPath.visible = open && this.view.layers.paths && this.view.mode !== 'assembled';
    this.reliefSpring.scale.y = 1 - this.poppet.position.y / (RELIEF_DETAIL.springTopY - RELIEF_DETAIL.springBottomY);
    this.reliefSpring.position.y = (D.reliefCenter[1] + RELIEF_DETAIL.springTopY) * (1 - this.reliefSpring.scale.y);
    this.capFluidMat.color.copy(this.view.pressureColors ? this.pressureColor(snapshot.portsPa.A) : new THREE.Color('#bba158'));
    this.rodFluidMat.color.copy(this.view.pressureColors ? this.pressureColor(snapshot.portsPa.B) : new THREE.Color('#bba158'));
    const returnPressure = snapshot.returnBackpressurePa ?? snapshot.portsPa.T;
    const valvePressure = { ...snapshot.portsPa, T: returnPressure };
    const internalColor = pressure => this.view.pressureColors ? this.pressureColor(pressure) : new THREE.Color('#93aeb3');
    for (const [id, material] of Object.entries(this.windowMaterials)) material.color.copy(internalColor(valvePressure[id.startsWith('T') ? 'T' : id]));
    for (const { port, material } of this.internalPorts) material.color.copy(internalColor(valvePressure[port]));
    for (const [index, port] of ['P', 'T'].entries()) this.reliefMaterials[index].color.copy(internalColor(snapshot.portsPa[port]));
    const neutralFlow = snapshot.connections.includes('P-T') && Math.abs(snapshot.flowsM3s.supplyToValve) > FLOW_THRESHOLD_M3S;
    this.bypassMaterial.color.copy(internalColor(snapshot.portsPa.P));
    this.bypass.visible = this.view.layers.paths && this.view.mode !== 'assembled';
    this.bypassMaterial.emissiveIntensity = neutralFlow ? .6 : .05;
    this.neutralArrows.visible = this.view.flowArrows && neutralFlow;
    for (const route of this.routes) {
      route.flowM3s = route.flowKeys.reduce((sum, key) => sum + snapshot.flowsM3s[key], 0);
      const showFlow = this.view.flowArrows && Math.abs(route.flowM3s) > FLOW_THRESHOLD_M3S;
      route.pressurePa = route.id === 'valve-return' ? returnPressure : snapshot.portsPa[route.pressurePort];
      route.bands.forEach((band, index) => {
        band.pressurePa = index === 0 ? route.pressurePa : snapshot.portsPa.T;
        band.material.color.copy(this.view.pressureColors ? this.pressureColor(band.pressurePa) : new THREE.Color('#6f7e82'));
        if (this.view.flowArrows && !showFlow) band.material.color.multiplyScalar(.64);
      });
      for (const arrow of route.arrows) arrow.visible = showFlow;
    }
    if (Math.abs(snapshot.flowsM3s.pumpFromTank) > FLOW_THRESHOLD_M3S) {
      this.pumpGears.children.forEach((gear, index) => { gear.rotation.z = timeS * 1.8 * (index === 0 ? 1 : -1) + (index === 0 ? 0 : Math.PI / 12); });
    }
    this.applyView(explode); this.highlight(this.view.selectedPart);
    for (const item of this.highlighted) { const original = Array.isArray(item.original) ? item.original : [item.original]; item.clones.forEach((material, index) => material.color.copy(original[index].color)); }
    // OrbitControls updates synchronously on input (damping is disabled). Calling
    // it again here would perturb a restored camera exactly on a polar boundary.
    this.updating = false; this.render();
  }

  applyView(explode = this.view.mode === 'exploded' ? this.view.explode : 0) {
    const cut = this.view.mode !== 'assembled', housing = this.view.layers.housing;
    for (const pair of this.housings) { pair.back.visible = housing; pair.front.visible = housing && (!cut || explode > 0); pair.front.position.set(...pair.displacement.map(value => value * explode)); }
    this.reliefSeatFront.visible = !cut || explode > 0; this.reliefSeatFront.position.z = .11 * explode;
    this.spoolFront.visible = !cut; this.capFluid.visible = cut && this.view.layers.paths; this.rodFluid.visible = cut && this.view.layers.paths;
    this.spoolBack.visible = true; this.cap.position.x = -.13 * explode; this.gland.position.x = .13 * explode;
    this.rodSeals.forEach((part, index) => { part.position.x = (.15 + index * .045) * explode; });
    for (const part of this.sealParts) part.visible = this.view.layers.seals;
    for (const port of this.internalPorts) for (const mesh of port.meshes) mesh.visible = cut && this.view.layers.paths;
    for (const mesh of this.galleryFluids) mesh.visible = cut && this.view.layers.paths;
    const notes = [];
    if (this.view.mode === 'exploded') notes.push('분해 관찰 · 배관은 조립 상태 기준');
    if (this.view.flowArrows) notes.push('화살표 이동 속도는 표시용');
    this.note.classList.toggle('is-scale', this.view.flowArrows && this.view.mode !== 'exploded');
    const text = notes.join(' · ');
    this.note.hidden = !text;
    if (this.note.textContent !== text) this.note.textContent = text;
  }

  orientRouteArrows() {
    const tangent = new THREE.Vector3(), normal = new THREE.Vector3(), side = new THREE.Vector3(), basis = new THREE.Matrix4();
    const forward = this.camera.getWorldDirection(new THREE.Vector3());
    const metreScale = 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) / (this.height * this.camera.zoom);
    for (const { arrows, curve, flowM3s, length, radius } of this.routes) {
      if (!arrows[0].visible) continue;
      const direction = Math.sign(flowM3s), margin = Math.min(.029 / length, .28);
      const phase = this.reducedMotion.matches ? 0 : this.timeS * ARROW_SPEED_MPS / (length * (1 - 2 * margin));
      arrows.forEach((arrow, index) => {
        const cycle = THREE.MathUtils.euclideanModulo((index + .5) / arrows.length + phase * direction, 1);
        const progress = THREE.MathUtils.lerp(margin, 1 - margin, cycle);
        curve.getPointAt(progress, arrow.position);
        curve.getTangentAt(progress, tangent).multiplyScalar(direction);
        normal.subVectors(this.camera.position, arrow.position);
        const depth = -normal.dot(forward);
        const closeUpScale = 28 * depth * metreScale / .020;
        arrow.scale.setScalar(clamp(closeUpScale, .05, arrow.userData.baseScale));
        side.crossVectors(normal, tangent);
        if (side.lengthSq() < 1e-10) side.crossVectors(this.camera.up, tangent);
        side.normalize();
        normal.crossVectors(tangent, side);
        arrow.position.addScaledVector(normal, radius + .002);
        arrow.quaternion.setFromRotationMatrix(basis.makeBasis(tangent, side, normal));
        arrow.userData.progress = progress;
      });
    }
  }

  highlight(id) {
    if (this.highlightId === id) return;
    for (const item of this.highlighted) { item.mesh.material = item.original; for (const material of item.clones) { this.materials.delete(material); material.dispose(); } }
    this.highlighted = []; this.highlightId = id;
    const component = this.components.get(id); if (!component) return;
    component.node.traverse(mesh => {
      if (!mesh.isMesh || mesh.userData.nonPickable || mesh.userData.partId !== id) return;
      const original = mesh.material, originals = Array.isArray(original) ? original : [original];
      const clones = originals.map(material => { const clone = material.clone(); clone.emissive = new THREE.Color('#52a9b6'); clone.emissiveIntensity = .36; this.materials.add(clone); return clone; });
      mesh.material = Array.isArray(original) ? clones : clones[0]; this.highlighted.push({ mesh, original, clones });
    });
  }
  select(id) { if (!this.components.has(id)) return; this.view.selectedPart = id; this.highlight(id); this.render(); this.onSelect(id); }
  pick(event) {
    if (!this.down || this.down.button !== 0 || Math.hypot(event.clientX - this.down.x, event.clientY - this.down.y) > 5) return;
    const rect = this.renderer.domElement.getBoundingClientRect(); this.pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObject(this.root, true).find(item => {
      let current = item.object; if (current.userData.nonPickable || !current.userData.partId) return false;
      while (current) { if (!current.visible) return false; current = current.parent; } return true;
    });
    if (hit) this.select(hit.object.userData.partId);
  }

  layoutLabels() {
    if (!this.labels || !this.width) return;
    const width = this.width, height = this.height, compact = width < 600, narrow = width <= 500;
    this.overlay.classList.toggle('is-narrow', narrow);
    const defaultIds = compact ? ['directional-spool', 'piston', 'tank', 'relief-poppet'] : ['tank', 'pump', 'directional-spool', 'relief-poppet', 'piston', 'rod', 'return-filter', 'load-carriage'];
    const candidates = [...new Set([this.view.selectedPart, ...(this.focusContext || defaultIds)])].filter(id => this.components.has(id));
    const projected = [], top = Math.min(86, Math.max(62, height * .14)), bottom = Math.max(top + 25, height - 75);
    if (this.view.labels && height >= 190 && width >= 180) {
      this.root.updateMatrixWorld(true);
      for (const id of candidates) {
        const component = this.components.get(id); let ancestor = component.node;
        while (ancestor?.visible) ancestor = ancestor.parent;
        if (ancestor) continue;
        const p = component.node.localToWorld(component.anchor.clone()).project(this.camera);
        if (p.z < -1 || p.z > 1 || p.x < -1 || p.x > 1 || p.y < -1 || p.y > 1) continue;
        projected.push({ id, x: (p.x * .5 + .5) * width, y: (-p.y * .5 + .5) * height });
        if (narrow && projected.length === 3) break;
      }
    }
    const visibleIds = new Set(projected.map(({ id }) => id));
    for (const [id, { button, line }] of this.labels) {
      const visible = visibleIds.has(id), selected = id === this.view.selectedPart;
      button.hidden = !visible; line.style.display = visible ? '' : 'none';
      button.classList.toggle('is-selected', selected); button.setAttribute('aria-pressed', selected);
    }

    const sides = [[], []];
    projected.sort((a, b) => a.x - b.x).forEach((item, index) => sides[index < Math.ceil(projected.length / 2) ? 0 : 1].push(item));
    const labelWidth = narrow ? Math.min(88, width * .27) : compact ? 113 : 142;
    const gap = narrow ? 7 : 10, halfHeight = narrow ? 16 : 15;
    for (let side = 0; side < 2; side++) {
      const list = sides[side].sort((a, b) => a.y - b.y), spacing = Math.min(48, (bottom - top) / Math.max(1, list.length - 1));
      let last = top - spacing;
      for (let index = 0; index < list.length; index++) {
        const p = list[index], label = this.labels.get(p.id), maxY = bottom - (list.length - index - 1) * spacing;
        const y = clamp(p.y, Math.max(top, last + spacing), maxY); last = y;
        const x = side === 0 ? gap : width - gap - labelWidth;
        label.button.style.left = `${x}px`; label.button.style.top = `${y - halfHeight}px`; label.button.style.width = `${labelWidth}px`;
        const endX = side === 0 ? x + labelWidth : x;
        label.line.setAttribute('d', `M ${clamp(p.x, 0, width)} ${clamp(p.y, 0, height)} L ${endX + (side ? -12 : 12)} ${y} L ${endX} ${y}`);
        label.line.classList.toggle('is-selected', p.id === this.view.selectedPart);
      }
    }
  }

  visibleBounds(node = this.root) {
    const bounds = new THREE.Box3(); node.updateMatrixWorld(true);
    node.traverseVisible(object => { if (object.isMesh) { object.geometry.computeBoundingBox(); bounds.union(object.geometry.boundingBox.clone().applyMatrix4(object.matrixWorld)); } });
    return bounds;
  }
  visiblePoints(node = this.root, region = null) {
    const points = []; node.updateMatrixWorld(true);
    node.traverseVisible(object => {
      if (!object.isMesh) return;
      object.geometry.computeBoundingBox();
      const bounds = object.geometry.boundingBox;
      for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
        const point = new THREE.Vector3(x, y, z).applyMatrix4(object.matrixWorld);
        if (!region || region.containsPoint(point)) points.push(point);
      }
    });
    return points;
  }
  fitBounds(bounds, direction = [.72, .50, 1.0], points = null) {
    if (bounds.isEmpty()) return;
    const center = bounds.getCenter(new THREE.Vector3());
    const dir = V(direction).normalize(), right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir).normalize(), up = new THREE.Vector3().crossVectors(dir, right).normalize();
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)), tanH = tanV * this.camera.aspect;
    if (!points?.length) {
      points = [];
      for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) points.push(new THREE.Vector3(x, y, z));
    }
    let distance = .20;
    // Fit the actual visible mesh distribution, not empty corners of a large box.
    // Recenter in projected space because a perspective view is not symmetric
    // around the world-space AABB centre (especially with the long load rails).
    for (let iteration = 0; iteration < 5; iteration++) {
      distance = .20;
      const relative = points.map(point => point.clone().sub(center));
      for (const point of relative) {
        const depth = point.dot(dir);
        distance = Math.max(distance, depth + Math.abs(point.dot(right)) / (tanH * .87), depth + Math.abs(point.dot(up)) / (tanV * .82));
      }
      if (iteration === 4) break;
      let left = Infinity, rightEdge = -Infinity, bottom = Infinity, top = -Infinity;
      for (const point of relative) {
        const denominator = Math.max(.001, distance - point.dot(dir));
        const x = point.dot(right) / denominator, y = point.dot(up) / denominator;
        left = Math.min(left, x); rightEdge = Math.max(rightEdge, x); bottom = Math.min(bottom, y); top = Math.max(top, y);
      }
      center.addScaledVector(right, (left + rightEdge) * distance / 2).addScaledVector(up, (bottom + top) * distance / 2);
    }
    this.updating = true; this.camera.zoom = 1; this.camera.updateProjectionMatrix();
    this.controls.target.copy(center); this.camera.position.copy(center.clone().addScaledVector(dir, Math.min(4, distance))); this.controls.update(); this.updating = false;
    this.render(); this.onCameraChange(this.getCameraState());
  }
  resetCamera(preset = 'iso') {
    this.focusContext = null;
    const groups = { cylinder: this.barrel, valve: this.valve, relief: this.relief, tank: this.tank };
    const subject = groups[preset] || this.root, bounds = this.visibleBounds(subject), points = this.visiblePoints(subject);
    if (preset === 'cylinder') for (const group of [this.cap, this.gland, this.piston, this.rod]) { bounds.union(this.visibleBounds(group)); points.push(...this.visiblePoints(group)); }
    this.fitBounds(bounds, preset === 'front' || preset === 'valve' ? [0, .13, 1] : preset === 'top' ? [.01, 1, .25] : [.55, .67, 1], points);
  }
  focusPart(id) {
    const part = this.components.get(id); if (!part) return false;
    let bounds = this.visibleBounds(part.node), direction = [.25, .25, 1], points = null;
    if (bounds.isEmpty()) return false;
    if (id.startsWith('relief-') || id === 'line-relief') {
      this.focusContext = ['relief-poppet', 'relief-spring', 'relief-adjuster', 'relief-body'];
      // Approach the open +Z half from the left and above: the front valve's
      // top rib lies to the right, and the tank wall is below this sight line.
      direction = [-.7, .32, 1];
      bounds = new THREE.Box3(V([D.reliefCenter[0] - .027, .123, D.reliefCenter[2] - .021]), V([D.reliefCenter[0] + .026, .221, D.reliefCenter[2] + .021]));
    } else if (id === 'pump') {
      this.focusContext = ['pump', 'pump-drive']; direction = [-.18, .85, 1];
      // The pump sits behind the tank. Frame its body above the pedestal and
      // approach over the tank wall so an explicit closeup reveals the gears.
      bounds.min.y = Math.max(bounds.min.y, D.pumpCenter[1] - .041);
    } else if (id.startsWith('directional-') || id.startsWith('port-') || id === 'centering-springs') {
      this.focusContext = ['directional-spool', 'centering-springs', 'port-P', 'port-A', 'port-B', 'port-T'];
      // A shallow view from the left keeps the T fitting and its external hose
      // clear of the spool's central land and drilled neutral passage.
      direction = [-.65, .12, 1];
      bounds = new THREE.Box3(V(D.valveCenter).add(V([-.108, -.044, -.030])), V(D.valveCenter).add(V([.111, .044, .050])));
      points = this.visiblePoints(this.valve, bounds);
    } else if (['piston', 'piston-seal', 'rod', 'cylinder-barrel', 'cap-end', 'rod-gland', 'rod-guide', 'rod-seal', 'wiper'].includes(id)) {
      this.focusContext = ['piston', 'piston-seal', 'rod', 'cylinder-barrel', 'rod-gland', 'rod-guide', 'rod-seal', 'wiper'];
      direction = [.20, .25, 1];
      if (id === 'piston' || id === 'piston-seal') {
        const center = this.piston.getWorldPosition(new THREE.Vector3());
        bounds = new THREE.Box3(center.clone().add(V([-.075, -.043, -.043])), center.clone().add(V([.075, .043, .043])));
      } else if (['rod-gland', 'rod-guide', 'rod-seal', 'wiper'].includes(id)) {
        const center = V([.061 + .13 * (this.view.mode === 'exploded' ? this.view.explode : 0), D.cylinderAxisY, 0]);
        bounds = new THREE.Box3(center.clone().add(V([-.045, -.045, -.045])), center.clone().add(V([.090, .045, .045])));
      } else { bounds.expandByScalar(.012); }
    } else if (['tank', 'tank-oil', 'suction-strainer'].includes(id)) {
      this.focusContext = ['tank', 'tank-oil', 'suction-strainer', 'line-suction']; direction = [.1, .45, 1];
      bounds = this.visibleBounds(this.tank).union(this.visibleBounds(this.tankOil)); points = this.visiblePoints(this.tank).concat(this.visiblePoints(this.tankOil));
    } else { this.focusContext = [id]; bounds.expandByScalar(.012); }
    this.fitBounds(bounds, direction, points); return true;
  }
  getCameraState() { return { position: this.camera.position.toArray().map(ordinary), target: this.controls.target.toArray().map(ordinary), zoom: ordinary(this.camera.zoom) }; }
  setCameraState(state) {
    if (!state || ![state.position, state.target].every(a => Array.isArray(a) && a.length === 3 && a.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 100))) return false;
    const position = V(state.position), target = V(state.target), distance = position.distanceTo(target), zoom = state.zoom ?? 1;
    if (distance < .20 - 1e-10 || distance > 4 + 1e-10 || !Number.isFinite(zoom) || zoom < .25 || zoom > 4) return false;
    this.focusContext = null; this.updating = true; this.camera.position.copy(position); this.controls.target.copy(target); this.camera.zoom = zoom; this.camera.updateProjectionMatrix();
    // OrbitControls may normalize a pole or a distance at its tolerance boundary.
    // Preserve the validated original camera after syncing its internal spherical coordinates.
    this.controls.update(); this.camera.position.copy(position); this.controls.target.copy(target); this.camera.lookAt(target); this.updating = false;
    this.render(); return true;
  }
  getComponents() { return COMPONENTS.map(component => ({ ...component })); }
  pumpVisibility() {
    if (!this.focusContext?.includes('pump')) return null;
    const ray = new THREE.Raycaster(), counts = [0, 0];
    this.pumpGearMeshes.forEach((mesh, index) => {
      for (let i = 0; i < 4; i++) {
        const angle = i * TAU / 4, point = mesh.localToWorld(V([.010 * Math.cos(angle), .010 * Math.sin(angle), mesh.geometry.boundingBox.max.z]));
        const direction = point.clone().sub(this.camera.position); ray.set(this.camera.position, direction.clone().normalize()); ray.far = direction.length() + .0001;
        const first = ray.intersectObject(this.root, true).find(hit => {
          if (hit.object.userData.nonPickable) return false;
          for (let node = hit.object; node; node = node.parent) if (!node.visible) return false;
          const material = Array.isArray(hit.object.material) ? hit.object.material[hit.face.materialIndex] : hit.object.material;
          return !(material.transparent && material.opacity < .5);
        });
        if (first?.object === mesh) counts[index]++;
      }
    });
    return { visible: counts[0] + counts[1], total: 8, perGear: counts };
  }
  mechanicalDiagnostics() {
    const contactRadiusM = (RELIEF_DETAIL.contactInnerRadiusM + RELIEF_DETAIL.contactOuterRadiusM) / 2;
    // A face-interior probe avoids floating-point ambiguity at shared radial edges.
    const probeAngle = -Math.PI / 96;
    const probeX = D.reliefCenter[0] + contactRadiusM * Math.cos(probeAngle), probeZ = D.reliefCenter[2] + contactRadiusM * Math.sin(probeAngle), ray = new THREE.Raycaster();
    ray.set(V([probeX, D.reliefCenter[1] + .05, probeZ]), V([0, -1, 0]));
    const seat = ray.intersectObject(this.reliefSeatMesh, false)[0];
    ray.set(V([probeX, D.reliefCenter[1] - .05, probeZ]), V([0, 1, 0]));
    const poppet = ray.intersectObject(this.poppetMesh, false)[0];
    const currentContactGapM = seat && poppet ? poppet.point.y - seat.point.y : null;
    const springCurve = this.reliefSpringMesh.geometry.parameters.path;
    const gearAxes = this.pumpGears.children.map(gear => gear.getWorldPosition(new THREE.Vector3()));
    const coverBounds = this.pumpCovers.map(mesh => new THREE.Box3().setFromObject(mesh));
    const gearBounds = this.pumpGearMeshes.map(mesh => new THREE.Box3().setFromObject(mesh));
    const cavityAxes = PUMP_DETAIL.gearCentersX.map(x => this.pumpHousingMesh.localToWorld(V([x, 0, 0])));
    const eccentricityM = Math.max(...gearAxes.map((axis, i) => Math.hypot(axis.x - cavityAxes[i].x, axis.y - cavityAxes[i].y)));
    return {
      pump: {
        gearAngles: this.pumpGears.children.map(gear => gear.rotation.z), gearAxes: gearAxes.map(axis => axis.toArray()),
        axisSeparationM: gearAxes[0].distanceTo(gearAxes[1]), pitchRadiusM: PUMP_DETAIL.pitchRadiusM,
        ...this.pumpClearance, radialClearanceLowerBoundM: this.pumpClearance.radialClearanceLowerBoundM - eccentricityM,
        axialClearancesM: gearBounds.map(bounds => ({ rear: bounds.min.z - coverBounds[0].max.z, front: coverBounds[1].min.z - bounds.max.z })),
        visibility: this.pumpVisibility(),
        motion: 'illustrative phase, not measured pump rpm',
      },
      relief: {
        open: this.poppet.position.y > 0, liftM: this.poppet.position.y, contactRadiusM,
        seatContact: seat?.point.toArray() ?? null, poppetContact: poppet?.point.toArray() ?? null,
        currentContactGapM, closedContactGapM: currentContactGapM == null ? null : currentContactGapM - this.poppet.position.y,
        springLower: this.reliefSpringMesh.localToWorld(springCurve.getPoint(0)).toArray(),
        springUpper: this.reliefSpringMesh.localToWorld(springCurve.getPoint(1)).toArray(),
        motion: 'binary illustrative lift, not solved flow area or spring force',
      },
    };
  }
  getDebug() {
    this.root.updateMatrixWorld(true);
    const volume = mesh => { const section = mesh.userData.section; return Math.PI * (section.outerRadiusM ** 2 - section.innerRadiusM ** 2) * section.baseLengthM * mesh.scale.x; };
    const tankSize = this.tankFluid.geometry.parameters;
    return {
      ready: !!this.snapshot, componentCount: this.components.size, meshCount: (() => { let count = 0; this.root.traverse(node => { if (node.isMesh) count++; }); return count; })(),
      pistonCenter: this.piston.getWorldPosition(new THREE.Vector3()).toArray(), rodCenter: this.rodMesh.getWorldPosition(new THREE.Vector3()).toArray(),
      pistonCenterX: this.piston.getWorldPosition(new THREE.Vector3()).x,
      spoolCenter: this.spool.getWorldPosition(new THREE.Vector3()).toArray(), spoolOffsetM: this.spool.position.x,
      spoolConnections: this.drawnSpool?.connections ?? [], capFluidLengthM: this.capFluid.scale.x, rodFluidLengthM: this.rodFluid.scale.x,
      capFluidVolumeM3: volume(this.capFluid), rodFluidVolumeM3: volume(this.rodFluid), tankVolumeM3: tankSize.width * tankSize.height * tankSize.depth * this.tankFluid.scale.y,
      tankSurfaceY: this.tankFluid.position.y + tankSize.height * this.tankFluid.scale.y / 2, mode: this.view.mode, selectedPart: this.view.selectedPart,
      routes: this.routes.map(route => {
        const visibleArrows = route.arrows.filter(arrow => arrow.visible);
        const arrow = visibleArrows[0];
        return {
          id: route.id, flowM3s: route.flowM3s, pressurePa: route.pressurePa,
          pressureBands: route.bands.map(({ pressurePa, material }) => ({ pressurePa, color: '#' + material.color.getHexString() })),
          visibleArrowCount: visibleArrows.length,
          arrowDirection: arrow ? V([1, 0, 0]).applyQuaternion(arrow.quaternion).dot(route.curve.getTangentAt(arrow.userData.progress)) : 0,
          start: route.curve.getPoint(0).toArray(), end: route.curve.getPoint(1).toArray(),
        };
      }),
      drawCalls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles, renderFrame: this.renderer.info.render.frame,
      camera: this.getCameraState(), render: { calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles },
      labels: [...this.labels].filter(([, label]) => !label.button.hidden).map(([id, label]) => ({ id, top: parseFloat(label.button.style.top), left: parseFloat(label.button.style.left) })),
      mechanical: this.mechanicalDiagnostics(), resources: { geometries: this.renderer.info.memory.geometries, textures: this.renderer.info.memory.textures },
    };
  }
  resize() {
    if (this.disposed) return;
    const width = Math.max(1, this.container.clientWidth), height = Math.max(1, this.container.clientHeight); this.width = width; this.height = height;
    this.renderer.setSize(width, height, false); this.camera.aspect = width / height; this.camera.updateProjectionMatrix(); this.render();
  }
  render() { if (this.disposed) return; this.camera.updateMatrixWorld(); this.orientRouteArrows(); this.layoutLabels(); this.renderer.render(this.scene, this.camera); }
  dispose() {
    if (this.disposed) return; this.disposed = true; this.resizeObserver.disconnect();
    this.controls.removeEventListener('change', this.controlChange); this.controls.dispose();
    this.renderer.domElement.removeEventListener('pointerdown', this.pointerDown); this.renderer.domElement.removeEventListener('pointerup', this.pointerUp);
    for (const geometry of this.geometries) geometry.dispose(); for (const material of this.materials) material.dispose();
    for (const texture of this.textures) texture.dispose();
    this.environment.dispose(); this.renderer.dispose(); this.renderer.domElement.remove(); this.overlay.remove(); this.container.classList.remove('hydraulic-scene');
  }
}
