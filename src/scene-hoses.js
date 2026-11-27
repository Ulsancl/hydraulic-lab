import * as THREE from 'three';

const v = values => new THREE.Vector3(...values);
const axes = [v([1, 0, 0]), v([0, 1, 0]), v([0, 0, 1])];
const face = v([0, .48, 1]).normalize();

export function hoseCurve(route, ports) {
  const points = route.points.map(v);
  const start = points[0], end = points.at(-1);
  if (route.id === 'relief-return') {
    // The smooth bend bows toward the barrel. Shift its crossover forward to
    // clear the steel with the full hose radius.
    points[2].z += .010;
    points[3].z += .010;
  }
  const shoulder = (id, socket, adjacent) => {
    const delta = adjacent.clone().sub(socket);
    const normal = v(ports[id].normal);
    const axis = axes.reduce((best, axis) => Math.abs(delta.dot(axis)) > Math.abs(delta.dot(best)) ? axis : best);
    const direction = !id.endsWith('tee') && delta.dot(normal) > 0 ? normal : axis.clone().multiplyScalar(Math.sign(delta.dot(axis)));
    return socket.clone().addScaledVector(direction, Math.min(.030, delta.length() * .54));
  };
  if (route.id === 'cap-line' || route.id === 'rod-line') {
    // Rise from each fixed port, then sweep back to the barrel as a service loop.
    const cap = route.id === 'cap-line', crown = cap ? .321 : .345;
    return new THREE.CatmullRomCurve3([
      start, start.clone().add(v([0, .036, 0])),
      v([start.x + (cap ? -.019 : .016), crown - .018, .122]),
      v([(start.x + end.x) / 2, crown, .058]),
      v([end.x + (cap ? .007 : -.009), crown - .011, .015]),
      end.clone().add(v([0, .018, 0])), end,
    ]);
  }
  return new THREE.CatmullRomCurve3([
    start, shoulder(route.from, start, points[1]),
    ...points.slice(1, -1), shoulder(route.to, end, points.at(-2)), end,
  ]);
}

export function hosePressureBand(curve, radius, segments, from, to) {
  const positions = [], indices = [];
  const widthSegments = 4;
  const point = new THREE.Vector3(), tangent = new THREE.Vector3();
  const binormal = new THREE.Vector3(), normal = new THREE.Vector3(), vertex = new THREE.Vector3();
  for (let row = 0; row <= segments; row++) {
    const progress = THREE.MathUtils.lerp(from, to, row / segments);
    curve.getPointAt(progress, point); curve.getTangentAt(progress, tangent);
    binormal.crossVectors(tangent, face);
    if (binormal.lengthSq() < 1e-6) binormal.crossVectors(tangent, axes[0]);
    binormal.normalize();
    normal.crossVectors(binormal, tangent);
    for (let col = 0; col <= widthSegments; col++) {
      const angle = (col / widthSegments - .5) * .92;
      vertex.copy(point).addScaledVector(normal, radius * Math.cos(angle)).addScaledVector(binormal, radius * Math.sin(angle));
      positions.push(...vertex.toArray());
      if (row < segments && col < widthSegments) {
        const first = row * (widthSegments + 1) + col, next = first + widthSegments + 1;
        indices.push(first, next, first + 1, first + 1, next, next + 1);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  return geometry;
}

export function flowArrowGeometry(size) {
  const vertices = [[-.007, -.0038], [.001, -.0038], [.001, -.0062], [.010, 0], [.001, .0062], [.001, .0038], [-.007, .0038]];
  const shape = new THREE.Shape(vertices.map(([x, y]) => new THREE.Vector2(x * size, y * size)));
  return new THREE.ShapeGeometry(shape);
}
