// three.js renderer: terrain mesh, TYCHO rover mesh, starfield/sun, chase camera.
// Imported only by main.js (never by the pure/tested modules).
import * as THREE from "three";

const TERRAIN_SEGMENTS = 384; // mesh resolution; downsampled from the DEM grid for perf
// Vertical clearance between the rover's rendered feet and the terrain mesh.
// The rover's y comes from a fine bilinear elev() sample at its exact
// position; the rendered mesh is a coarser, flat-shaded-per-quad
// approximation of the same DEM. On real, rough terrain those two can
// diverge by a few meters within one quad, which buries an unlit rover mesh
// under the rendered surface. This offset keeps it visibly above ground.
const ROVER_GROUND_CLEARANCE = 1.5;

/** Build the procedural TYCHO rover: six wheels, a boxy body, a mast with a two-lens "face", an antenna. */
function buildRoverMesh() {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xd8d2c4, metalness: 0.3, roughness: 0.6 });
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x24211d, metalness: 0.1, roughness: 0.9 });
  const lensMat = new THREE.MeshStandardMaterial({ color: 0x2a6fdb, emissive: 0x0a2a5c, metalness: 0.4, roughness: 0.2 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.4, 1.4), bodyMat);
  body.position.y = 0.45;
  group.add(body);

  // Six wheels, rocker-bogie hint via slightly uneven mount heights front/mid/rear.
  const wheelGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.18, 12);
  const mounts = [
    [-0.55, 0.22, 0.55], [0.55, 0.22, 0.55],
    [-0.6, 0.2, 0], [0.6, 0.2, 0],
    [-0.55, 0.24, -0.55], [0.55, 0.24, -0.55],
  ];
  for (const [x, y, z] of mounts) {
    const wheel = new THREE.Mesh(wheelGeo, wheelMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(x, y, z);
    group.add(wheel);
  }

  // Mast with a two-lens "face" camera head (WALL-E/EVE nod).
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.6, 8), bodyMat);
  mast.position.set(0, 0.95, 0.5);
  group.add(mast);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.16, 0.14), bodyMat);
  head.position.set(0, 1.28, 0.5);
  group.add(head);
  for (const side of [-1, 1]) {
    const lens = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 10), lensMat);
    lens.position.set(side * 0.08, 1.28, 0.58);
    group.add(lens);
  }

  // Antenna.
  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.5, 6), bodyMat);
  antenna.position.set(-0.35, 0.9, -0.4);
  antenna.rotation.z = 0.3;
  group.add(antenna);

  return group;
}

/** Build a downsampled, elevation-displaced terrain mesh from the shared terrain interface. */
function buildTerrainMesh(terrain, exaggeration) {
  const segs = Math.min(TERRAIN_SEGMENTS, Math.max(terrain.width, terrain.height));
  const worldW = terrain.width * terrain.metersPerPixel;
  const worldH = terrain.height * terrain.metersPerPixel;
  const geometry = new THREE.PlaneGeometry(worldW, worldH, segs - 1, segs - 1);
  geometry.rotateX(-Math.PI / 2);

  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i++) {
    const px = position.getX(i);
    const pz = position.getZ(i);
    const tx = (px / worldW + 0.5) * (terrain.width - 1);
    const ty = (pz / worldH + 0.5) * (terrain.height - 1);
    const elevM = terrain.elev(tx, ty);
    position.setY(i, elevM * exaggeration);
  }
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    color: terrain.synthetic ? 0x8a8378 : 0xb0aa9e,
    roughness: 1,
    metalness: 0,
    flatShading: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = false;
  return mesh;
}

function buildStarfield() {
  const count = 2000;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const r = 800 + Math.random() * 400;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = Math.abs(r * Math.sin(phi) * Math.sin(theta));
    positions[i * 3 + 2] = r * Math.cos(phi);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({ color: 0xffffff, size: 1.5, sizeAttenuation: false });
  return new THREE.Points(geo, mat);
}

/**
 * Create the TYCHO scene. Returns { available, renderer } plus methods to
 * update from sim state and resize/dispose. `available` is false if WebGL
 * could not be created (canvas 2D fallback is out of scope for the skeleton;
 * the caller shows the DOM fallback message).
 */
export function createScene(canvas, terrain, { exaggeration = 1.0, albedoUrl = null } = {}) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  } catch {
    return { available: false, rendererType: "none" };
  }
  if (!renderer) return { available: false, rendererType: "none" };

  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  scene.add(buildStarfield());

  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(-300, 120, 200); // low-angle sun for surface relief
  scene.add(sun);
  // Real DEM crater terrain can put the spawn point on a slope facing away
  // from the sun; a modest ambient floor keeps the scene legible instead of
  // rendering a near-black frame on an unlucky spawn orientation.
  scene.add(new THREE.AmbientLight(0x606a75, 1.0));

  const terrainMesh = buildTerrainMesh(terrain, exaggeration);
  scene.add(terrainMesh);
  if (albedoUrl) {
    new THREE.TextureLoader().load(
      albedoUrl,
      (tex) => { terrainMesh.material.map = tex; terrainMesh.material.color.set(0xffffff); terrainMesh.material.needsUpdate = true; },
      undefined,
      () => { /* no albedo asset yet; the flat-shaded material stands in */ },
    );
  }

  const lastKnownRover = buildRoverMesh();
  scene.add(lastKnownRover);

  // Faint ghost/prediction line trailing from the last-known position.
  const ghostGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  const ghostMat = new THREE.LineDashedMaterial({ color: 0x4fa8ff, dashSize: 0.3, gapSize: 0.2, transparent: true, opacity: 0.5 });
  const ghostLine = new THREE.Line(ghostGeo, ghostMat);
  ghostLine.computeLineDistances();
  scene.add(ghostLine);

  const camera = new THREE.PerspectiveCamera(60, canvas.clientWidth / Math.max(1, canvas.clientHeight), 0.1, 3000);

  function worldPos(pixelX, pixelY) {
    const worldW = terrain.width * terrain.metersPerPixel;
    const worldH = terrain.height * terrain.metersPerPixel;
    const x = (pixelX / (terrain.width - 1) - 0.5) * worldW;
    const z = (pixelY / (terrain.height - 1) - 0.5) * worldH;
    const y = terrain.elev(pixelX, pixelY) * exaggeration;
    return new THREE.Vector3(x, y, z);
  }

  /** Update the last-known rover and chase camera from a visible (delayed) telemetry state. */
  function updateFromVisibleState(visibleState) {
    if (!visibleState) return;
    const pos = worldPos(visibleState.x, visibleState.y);
    lastKnownRover.position.set(pos.x, pos.y + ROVER_GROUND_CLEARANCE, pos.z);
    lastKnownRover.rotation.y = (visibleState.heading * Math.PI) / 180;

    const headingRad = (visibleState.heading * Math.PI) / 180;
    const behind = new THREE.Vector3(-Math.sin(headingRad), 0, -Math.cos(headingRad)).multiplyScalar(6);
    const camPos = pos.clone().add(behind).add(new THREE.Vector3(0, 3.2, 0));
    camera.position.lerp(camPos, 0.08);
    camera.lookAt(pos.x, pos.y + 0.6, pos.z);

    const ghostEnd = pos.clone();
    ghostEnd.x += Math.sin(headingRad) * visibleState.speed * 1.5;
    ghostEnd.z += Math.cos(headingRad) * visibleState.speed * 1.5;
    ghostGeo.setFromPoints([pos.clone().setY(pos.y + ROVER_GROUND_CLEARANCE), ghostEnd.setY(pos.y + ROVER_GROUND_CLEARANCE)]);
    ghostGeo.attributes.position.needsUpdate = true;
    ghostLine.computeLineDistances();
  }

  function resize(width, height) {
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
  }

  function render() {
    renderer.render(scene, camera);
  }

  function dispose() {
    renderer.dispose();
  }

  return {
    available: true,
    rendererType: "webgl",
    updateFromVisibleState,
    resize,
    render,
    dispose,
    camera,
  };
}
