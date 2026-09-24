// Camera: a lagging chase cam with mouse/touch orbit and zoom, a skippable
// cinematic intro (open on Earth or the Martian sun halo, then swing down
// and in behind the rover), and a slow attract orbit while the title is up.
import * as THREE from "three";

const INTRO_HOLD = 0.9;
const INTRO_MOVE = 2.9;

function easeInOut(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}
function approach(current, target, rate, dt) {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

export function createCameraRig(camera, dom, { groundAt, openingDir }) {
  const st = {
    mode: "chase", yawOff: 0, pitch: 0.13, dist: 5.8, lift: 0.95, ahead: 2.2, lastInput: -10, time: 0,
    introT: 0, introFrom: null, attractAngle: 0, heading: 0, init: false,
  };
  const pointers = new Map();
  let pinchStart = 0;
  let pinchDist = 0;
  const pos = new THREE.Vector3();
  const look = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const qA = new THREE.Quaternion();
  const qB = new THREE.Quaternion();
  const m = new THREE.Matrix4();
  const up = new THREE.Vector3(0, 1, 0);

  function skipIntro() {
    if (st.mode === "intro") st.introT = Math.max(st.introT, INTRO_HOLD + INTRO_MOVE - 0.35);
  }
  const onDown = (e) => {
    skipIntro();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = Math.hypot(a.x - b.x, a.y - b.y);
      pinchDist = st.dist;
    }
    dom.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    st.lastInput = st.time;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchStart > 0) st.dist = THREE.MathUtils.clamp(pinchDist * (pinchStart / Math.max(20, d)), 2.2, 60);
      return;
    }
    st.yawOff -= dx * 0.006;
    st.pitch = THREE.MathUtils.clamp(st.pitch + dy * 0.004, -0.05, 1.35);
  };
  const onUp = (e) => { pointers.delete(e.pointerId); pinchStart = 0; };
  const onWheel = (e) => {
    skipIntro();
    st.lastInput = st.time;
    st.dist = THREE.MathUtils.clamp(st.dist * 1.0015 ** e.deltaY, 2.2, 60);
    e.preventDefault();
  };
  const onKey = () => skipIntro();
  dom.addEventListener("pointerdown", onDown);
  dom.addEventListener("pointermove", onMove);
  dom.addEventListener("pointerup", onUp);
  dom.addEventListener("pointercancel", onUp);
  dom.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("keydown", onKey);
  dom.style.touchAction = "none";

  function chasePose(target, heading, outPos, outLook) {
    const yaw = heading + st.yawOff;
    const cp = Math.cos(st.pitch);
    // Look a little ahead of the rover when behind it; when orbited round to
    // the front, look at the rover itself so the camera never ends up inside it.
    const ahead = st.ahead * Math.max(0, Math.cos(st.yawOff));
    outLook.copy(target).add(tmp.set(Math.sin(heading) * ahead, st.lift, Math.cos(heading) * ahead));
    outPos.set(
      outLook.x - Math.sin(yaw) * cp * st.dist,
      outLook.y + Math.sin(st.pitch) * st.dist,
      outLook.z - Math.cos(yaw) * cp * st.dist,
    );
    const floor = groundAt(outPos.x, outPos.z) + 0.55;
    if (outPos.y < floor) outPos.y = floor;
  }

  function startIntro(target, heading) {
    st.mode = "intro";
    st.introT = 0;
    const back = new THREE.Vector3(-Math.sin(heading), 0, -Math.cos(heading));
    const side = new THREE.Vector3(Math.cos(heading), 0, -Math.sin(heading));
    const from = target.clone().addScaledVector(back, 90).addScaledVector(side, 38);
    from.y = Math.max(from.y, groundAt(from.x, from.z)) + 42;
    st.introFrom = from;
  }

  const lookQuat = (from, to, out) => {
    m.lookAt(from, to, up);
    return out.setFromRotationMatrix(m);
  };

  let override = null;
  const baseFov = camera.fov;
  /** frame: { target (rover ground position), heading (rad), speed, attract (bool), dt } */
  function update(dt, frame) {
    st.time += dt;
    if (override && !frame.attract) {
      if (st.lastInput > override.at) { override = null; camera.fov = baseFov; camera.updateProjectionMatrix(); }
      else {
        const p = override.pose(frame.target);
        camera.position.copy(p.position);
        camera.lookAt(p.look);
        if (camera.fov !== p.fov) { camera.fov = p.fov; camera.updateProjectionMatrix(); }
        return;
      }
    }
    const { target, heading } = frame;
    if (!st.init) { st.heading = heading; st.init = true; }
    st.heading = st.heading + Math.atan2(Math.sin(heading - st.heading), Math.cos(heading - st.heading)) * (1 - Math.exp(-3 * dt));

    if (frame.attract) {
      // Slow orbit, low to the ground, the rover held in the right third so the
      // title text on the left never covers it.
      st.mode = "attract";
      st.attractAngle += dt * 0.05;
      const a = heading + Math.PI * 0.75 + st.attractAngle;
      pos.set(target.x + Math.sin(a) * 7.5, 0, target.z + Math.cos(a) * 7.5);
      pos.y = Math.max(target.y + 1.5, groundAt(pos.x, pos.z) + 1.1);
      const toRover = tmp.set(target.x - pos.x, 0, target.z - pos.z).normalize();
      const right = new THREE.Vector3(-toRover.z, 0, toRover.x);
      if (camera.aspect < 1) {
        // Portrait: the title sits in the lower half, so hold the rover high and centred.
        look.copy(target);
        look.y -= 1.6;
        pos.y += 1.2;
      } else {
        look.copy(target).addScaledVector(right, -3.2);
        look.y += 1.6;
      }
      camera.position.copy(pos);
      camera.lookAt(look);
      return;
    }
    if (st.mode === "attract") startIntro(target, heading);

    // Drift the orbit back behind the rover a few seconds after the last input.
    if (st.time - st.lastInput > 3 && pointers.size === 0 && Math.abs(frame.speed) > 0.2) {
      st.yawOff = approach(st.yawOff, 0, 0.8, dt);
    }
    chasePose(target, st.heading, pos, look);

    if (st.mode === "intro") {
      st.introT += dt;
      const u = easeInOut(THREE.MathUtils.clamp((st.introT - INTRO_HOLD) / INTRO_MOVE, 0, 1));
      const drift = Math.min(st.introT, INTRO_HOLD) * 3;
      const from = tmp.copy(st.introFrom).add(new THREE.Vector3(0, drift, 0));
      const mid = from.clone().lerp(pos, 0.55);
      mid.y += 18 * (1 - u);
      const a = from.clone().lerp(mid, u);
      const b = mid.clone().lerp(pos, u);
      camera.position.copy(a.lerp(b, u));
      const opening = camera.position.clone().add(openingDir);
      lookQuat(camera.position, opening, qA);
      lookQuat(camera.position, look, qB);
      camera.quaternion.copy(qA).slerp(qB, THREE.MathUtils.smoothstep(u, 0.05, 0.8));
      if (st.introT >= INTRO_HOLD + INTRO_MOVE) st.mode = "chase";
      return;
    }

    camera.position.x = approach(camera.position.x, pos.x, 5, dt);
    camera.position.y = approach(camera.position.y, pos.y, 5, dt);
    camera.position.z = approach(camera.position.z, pos.z, 5, dt);
    const floor = groundAt(camera.position.x, camera.position.z) + 0.5;
    if (camera.position.y < floor) camera.position.y = floor;
    camera.lookAt(look);
  }

  return {
    update,
    startIntro,
    skipIntro,
    get mode() { return st.mode; },
    /** Hold a scripted pose (fn of rover target) until the player touches the camera. */
    setPose(pose) { override = pose ? { pose, at: st.time } : null; if (!pose) { camera.fov = baseFov; camera.updateProjectionMatrix(); } },
    setView(view) {
      if (override) { override = null; camera.fov = baseFov; camera.updateProjectionMatrix(); }
      st.yawOff = view.yawOff; st.pitch = view.pitch; st.dist = view.dist;
      st.lift = view.lift ?? 0.95; st.ahead = view.ahead ?? 2.2;
      st.lastInput = st.time;
      if (st.mode === "intro") st.mode = "chase";
    },
    snapTo(target, heading) { chasePose(target, heading, pos, look); camera.position.copy(pos); camera.lookAt(look); st.heading = heading; st.init = true; },
    dispose() {
      dom.removeEventListener("pointerdown", onDown);
      dom.removeEventListener("pointermove", onMove);
      dom.removeEventListener("pointerup", onUp);
      dom.removeEventListener("pointercancel", onUp);
      dom.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
    },
  };
}
