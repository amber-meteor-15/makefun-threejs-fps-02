// The map: Kestrel Foundry, an original dusk-lit yard built from boxes. Two plant
// sites in walled halls at the north end (A west, B east), a mid block with four
// doors, west and east lanes, and a south link — lanes, corners and sightlines in
// the tactical style, with crates and low walls as crouch cover. Every solid box is
// a player collider and a surface bullets stop on. The module also owns the bot
// waypoint graph and the A* search over it.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

export function createWorld(scene) {
  const group = new THREE.Group();
  scene.add(group);

  const materials = {};
  for (const name of ['ground', 'surface', 'hairline', 'steel', 'ink', 'muted', 'accent', 'accentCool', 'warden', 'jackal', 'foliage']) {
    materials[name] = new THREE.MeshStandardMaterial({
      color: new THREE.Color(PALETTE[name]),
      roughness: name === 'steel' ? 0.45 : 0.9,
      metalness: name === 'steel' ? 0.55 : 0.04,
    });
  }
  const glowA = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.accent), emissive: new THREE.Color(PALETTE.accent), emissiveIntensity: 1.6, roughness: 0.6 });
  const glowB = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.accentCool), emissive: new THREE.Color(PALETTE.accentCool), emissiveIntensity: 1.2, roughness: 0.6 });

  const colliders = [];
  const shootables = [];

  function box(w, h, d, x, y, z, material, { solid = true, shoot = true } = {}) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), materials[material] ?? material);
    mesh.position.set(x, y, z);
    mesh.castShadow = h > 0.4;
    mesh.receiveShadow = true;
    group.add(mesh);
    if (solid) colliders.push(new THREE.Box3().setFromObject(mesh));
    if (shoot) shootables.push(mesh);
    return mesh;
  }
  // A wall run along x or z between two points, height h, centred on the line.
  function wall(x1, z1, x2, z2, h = 4, material = 'surface') {
    if (x1 === x2) return box(0.6, h, Math.abs(z2 - z1), x1, h / 2, (z1 + z2) / 2, material);
    return box(Math.abs(x2 - x1), h, 0.6, (x1 + x2) / 2, h / 2, z1, material);
  }
  function crate(x, z, h = 1.1) {
    box(1.1, h, 1.1, x, h / 2, z, 'hairline');
    if (h > 1.5) box(1.14, 0.08, 1.14, x, h - 0.3, z, 'steel'); // a band on tall stacks
  }
  function barrels(x, z) {
    const geo = new THREE.CylinderGeometry(0.34, 0.34, 0.95, 12);
    for (const [ox, oz] of [[0, 0], [0.72, 0.2], [0.3, 0.68]]) {
      const mesh = new THREE.Mesh(geo, materials.steel);
      mesh.position.set(x + ox, 0.48, z + oz);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      shootables.push(mesh);
    }
    const bounds = new THREE.Box3(new THREE.Vector3(x - 0.36, 0, z - 0.36), new THREE.Vector3(x + 1.1, 0.95, z + 1.05));
    colliders.push(bounds);
  }

  // --- Ground and perimeter -------------------------------------------------
  box(73, 0.4, 49, 0, -0.2, 0, 'ground');
  wall(-36, -24, 36, -24, 5);
  wall(-36, 24, 36, 24, 5);
  wall(-36, -24, -36, 24, 5);
  wall(36, -24, 36, 24, 5);
  // Paving slabs: slightly raised zones that tint the yards and spawns.
  box(16, 0.04, 7, 0, 0.02, -19.5, 'hairline', { solid: false, shoot: false });
  box(16, 0.04, 7, 0, 0.02, 19.5, 'hairline', { solid: false, shoot: false });
  box(3.2, 0.04, 34, 0, 0.02, -2, 'hairline', { solid: false, shoot: false });

  // --- Site A hall (west) and Site B warehouse (east) -----------------------
  // South walls with a door gap, east/west inner walls with a door gap.
  wall(-34, -5, -25, -5); wall(-23, -5, -15, -5); // A south
  wall(-15, -22, -15, -13); wall(-15, -11, -15, -5); // A east
  wall(15, -5, 23, -5); wall(25, -5, 34, -5); // B south
  wall(15, -22, 15, -13); wall(15, -11, 15, -5); // B west
  // Hall rooflines: a steel beam and hanging banner in each site colour.
  box(19, 0.35, 0.35, -24.5, 4.4, -5, 'steel');
  box(19, 0.35, 0.35, 24.5, 4.4, -5, 'steel');
  box(3.4, 1.6, 0.1, -24, 3.2, -5.4, glowA, { solid: false, shoot: false });
  box(3.4, 1.6, 0.1, 24, 3.2, -5.4, glowB, { solid: false, shoot: false });

  // The furnace in A: a steel cylinder with a glowing mouth (visual cylinder,
  // square collider, like every prop here).
  const furnace = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.9, 3.2, 18), materials.steel);
  furnace.position.set(-29, 1.6, -18);
  furnace.castShadow = true;
  furnace.receiveShadow = true;
  group.add(furnace);
  shootables.push(furnace);
  colliders.push(new THREE.Box3(new THREE.Vector3(-30.8, 0, -19.8), new THREE.Vector3(-27.2, 3.2, -16.2)));
  const furnaceMouth = box(1.1, 0.9, 0.2, -29, 0.9, -16.2, glowA, { solid: false, shoot: false });
  const chimney = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.6, 3.4, 12), materials.steel);
  chimney.position.set(-29, 4.8, -18);
  group.add(chimney);

  // Crates and cover.
  for (const [x, z, h] of [
    [-20, -19, 2.2], [-19, -9, 1.1], [-31, -9, 1.1],
    [20, -19, 2.2], [19, -9, 1.1], [31, -9, 1.1], [27, -8, 1.1],
    [-6, -16, 1.1], [6, -16, 1.1],
    [-10, 12, 1.1], [10, 12, 1.1], [0, 15, 2.2], [-18, 17, 1.1], [18, 17, 1.1],
    [-24, 2, 1.1], [24, 2, 1.1],
    [-3, -18, 1.1], [3, -18, 1.1],
  ]) crate(x, z, h);
  barrels(-12, -4.6); barrels(11, -4.6); barrels(-28, 12); barrels(27, 11);
  // Planter boxes soften the spawn yards.
  for (const [x, z] of [[-14, -21], [14, -21], [-14, 21], [14, 21]]) {
    box(2.6, 0.6, 1, x, 0.3, z, 'hairline');
    box(2.4, 0.25, 0.85, x, 0.72, z, 'foliage', { solid: false });
  }

  // --- Mid block: a square building, four doors, two pillars inside ---------
  wall(-3.5, -9, -3.5, -3); wall(-3.5, -1, -3.5, 3); // west, door z -3..-1
  wall(3.5, -9, 3.5, -3); wall(3.5, -1, 3.5, 3); // east, door z -3..-1
  wall(-3.5, -9, -1, -9); wall(1, -9, 3.5, -9); // north, door x -1..1
  wall(-3.5, 3, -1, 3); wall(1, 3, 3.5, 3); // south, door x -1..1
  box(1, 4, 1, 2, 2, -5.5, 'surface');
  box(1, 4, 1, -2, 2, -1, 'surface');
  box(7.6, 0.3, 13.6, 0, 4.15, -3, 'steel'); // mid roof slab

  // --- Lanes and links -------------------------------------------------------
  wall(-31, -6, -31, 6, 4); // west lane inner wall
  wall(31, -6, 31, 6, 4); // east lane inner wall
  box(1, 4, 1, -10, 2, -14, 'surface'); // north yard pillars
  box(1, 4, 1, 10, 2, -14, 'surface');
  box(5, 1.1, 0.5, -13.5, 0.55, 8, 'hairline'); // south link crouch walls
  box(5, 1.1, 0.5, 13.5, 0.55, 8, 'hairline');
  box(4, 1.1, 0.5, -4, 0.55, 10, 'hairline');
  box(4, 1.1, 0.5, 4, 0.55, 10, 'hairline');

  // --- Site pads: a ring, a disc and a light beam in the site colour --------
  const sites = {};
  function sitePad(id, x, z, material, colorHex) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(4.1, 4.5, 40), new THREE.MeshBasicMaterial({ color: new THREE.Color(colorHex), side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.03, z);
    group.add(ring);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(4.1, 40), new THREE.MeshBasicMaterial({ color: new THREE.Color(colorHex), transparent: true, opacity: 0.1, side: THREE.DoubleSide }));
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(x, 0.025, z);
    group.add(disc);
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, 26, 8, 1, true),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(colorHex), transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }),
    );
    beam.position.set(x, 13, z);
    group.add(beam);
    sites[id] = { id, x, z, radius: 4.5 };
  }
  sitePad('A', -26, -15, glowA, PALETTE.accent);
  sitePad('B', 26, -15, glowB, PALETTE.accentCool);

  // --- Light -----------------------------------------------------------------
  const sky = new THREE.HemisphereLight(new THREE.Color('#ffd9a6'), new THREE.Color('#2e2115'), 1.3);
  scene.add(sky);
  const sun = new THREE.DirectionalLight(new THREE.Color('#ffb066'), 2.7);
  sun.position.set(-26, 30, 18);
  sun.target.position.set(4, 0, -4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -42;
  sun.shadow.camera.right = 42;
  sun.shadow.camera.top = 42;
  sun.shadow.camera.bottom = -42;
  sun.shadow.camera.far = 95;
  sun.shadow.bias = -0.0005;
  scene.add(sun, sun.target);
  const fill = new THREE.DirectionalLight(new THREE.Color(PALETTE.accentCool), 0.5);
  fill.position.set(20, 12, -24);
  scene.add(fill);
  const midInterior = new THREE.PointLight(new THREE.Color('#ffca7a'), 17, 12, 1.8);
  midInterior.position.set(0, 3.1, -3);
  scene.add(midInterior);
  const furnaceLight = new THREE.PointLight(new THREE.Color(PALETTE.accent), 55, 19, 1.8);
  furnaceLight.position.set(-27.5, 2.4, -15.5);
  scene.add(furnaceLight);
  const siteBLight = new THREE.PointLight(new THREE.Color(PALETTE.accentCool), 34, 17, 1.8);
  siteBLight.position.set(26, 3.6, -15);
  scene.add(siteBLight);
  const midLight = new THREE.PointLight(new THREE.Color('#ffd9a6'), 26, 15, 1.8);
  midLight.position.set(0, 4.2, 7);
  scene.add(midLight);
  // Lamp poles at the lit points.
  for (const [x, z] of [[26, -15], [0, 7]]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 4.2, 8), materials.steel);
    pole.position.set(x + 1.4, 2.1, z + 1.4);
    group.add(pole);
    colliders.push(new THREE.Box3(new THREE.Vector3(x + 1.3, 0, z + 1.3), new THREE.Vector3(x + 1.5, 4.2, z + 1.5)));
  }

  let flicker = 0;
  function update(dt, time) {
    flicker += dt;
    const wave = Math.sin(time * 11) * 0.5 + Math.sin(time * 23 + 1.7) * 0.3 + Math.sin(time * 5 + 0.4) * 0.2;
    furnaceLight.intensity = 55 + wave * 9;
    furnaceMouth.material.emissiveIntensity = 1.6 + wave * 0.35;
  }

  // --- Waypoint graph ----------------------------------------------------------
  // Nodes are [x, z]; edges are index pairs. Every edge is a straight walk that
  // clears the colliders above (checked against the layout by hand).
  const nodeList = [
    [-8, 20], [0, 20], [8, 20], // 0-2 jackal spawn
    [-14, 13], [0, 12], [14, 13], // 3-5 south yard
    [-20, 5], [20, 5], // 6-7 links
    [-24, -1], [24, -1], // 8-9 lanes
    [0, 7], // 10 mid south approach
    [0, 0.5], [0, -7], // 11-12 mid interior
    [-5, -2], [5, -2], // 13-14 mid side doors (outside)
    [0, -10], [0, -13], // 15-16 mid north
    [-24, -2.5], [-24, -8], [-22, -12], [-26, -15], [-19, -17], [-13, -12], [-17, -12], // 17-23 A side
    [24, -2.5], [24, -8], [22, -12], [26, -15], [19, -17], [13, -12], [17, -12], // 24-30 B side
    [-8, -20], [0, -20], [8, -20], // 31-33 warden spawn
  ];
  const edgePairs = [
    [0, 3], [1, 4], [2, 5], [0, 1], [1, 2], [3, 4], [4, 5],
    [3, 6], [4, 10], [5, 7], [6, 8], [7, 9], [6, 10], [7, 10],
    [8, 17], [9, 24], [8, 13], [9, 14],
    [10, 11], [11, 12], [12, 15], [15, 16], [13, 12], [14, 12],
    [16, 22], [16, 29], [16, 32],
    [17, 18], [18, 19], [19, 20], [20, 21], [19, 23], [23, 22], [22, 31], [21, 20],
    [24, 25], [25, 26], [26, 27], [27, 28], [26, 30], [30, 29], [29, 33],
    [31, 32], [32, 33], [31, 22], [33, 29],
    [13, 8], [14, 9],
  ];
  const nodes = nodeList.map(([x, z]) => ({ x, z }));
  const neighbors = nodes.map(() => []);
  for (const [a, b] of edgePairs) {
    neighbors[a].push(b);
    neighbors[b].push(a);
  }
  const nav = { nodes, neighbors };

  const spawns = {
    warden: [[-6, -20], [0, -20.5], [6, -20], [-3, -21]],
    jackal: [[-6, 20], [0, 20.5], [6, 20], [3, 21]],
  };

  return { colliders, shootables, group, sites, nav, spawns, update };
}

// A* over the waypoint graph: index path from the node nearest `from` to the node
// nearest `to`, or null when either point is off the graph's island.
export function findPath(nav, fromX, fromZ, toX, toZ) {
  const start = nearestNode(nav, fromX, fromZ);
  const goal = nearestNode(nav, toX, toZ);
  if (start === goal) return [goal];
  const open = new Set([start]);
  const cameFrom = new Map();
  const gScore = new Map([[start, 0]]);
  const fScore = new Map([[start, heuristic(nav, start, goal)]]);
  while (open.size) {
    let current = -1;
    let best = Infinity;
    for (const idx of open) {
      const f = fScore.get(idx) ?? Infinity;
      if (f < best) { best = f; current = idx; }
    }
    if (current === goal) {
      const path = [current];
      let node = current;
      while (cameFrom.has(node)) {
        node = cameFrom.get(node);
        path.unshift(node);
      }
      return path;
    }
    open.delete(current);
    for (const next of nav.neighbors[current]) {
      const stepCost = Math.hypot(nav.nodes[next].x - nav.nodes[current].x, nav.nodes[next].z - nav.nodes[current].z);
      const tentative = (gScore.get(current) ?? Infinity) + stepCost;
      if (tentative < (gScore.get(next) ?? Infinity)) {
        cameFrom.set(next, current);
        gScore.set(next, tentative);
        fScore.set(next, tentative + heuristic(nav, next, goal));
        open.add(next);
      }
    }
  }
  return null;
}

function heuristic(nav, a, b) {
  return Math.hypot(nav.nodes[a].x - nav.nodes[b].x, nav.nodes[a].z - nav.nodes[b].z);
}

export function nearestNode(nav, x, z) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < nav.nodes.length; i += 1) {
    const d = Math.hypot(nav.nodes[i].x - x, nav.nodes[i].z - z);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}
