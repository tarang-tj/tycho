// Articulation for the TYCHO model: rocker-bogie suspension solved from the
// ground height under each wheel, body pitch/roll from the rocker
// differential, wheel spin, corner steering, a head that looks where it is
// going (and glances around when idle), blinking, the dish tracking Earth,
// and the status light.
import * as THREE from "three";
import { DIM } from "./rover-model.js";

const STATUS_COLORS = { nominal: 0x3dff7a, waiting: 0xffb52e, hold: 0xff3b30 };

function wrapPi(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
function approach(current, target, rate, dt) {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

/** Solve one side of the rocker-bogie for hub heights yF, yM, yR (world y). */
function solveSide(yF, yM, yR) {
  const { zF, zM, zR, wheelR: r, bogieRise, pivotZ, pivotY } = DIM;
  const zB = (zM + zR) / 2;
  const bogie = Math.atan2(yM - yR, zM - zR);
  const yB = (yM + yR) / 2 + bogieRise;
  const a0 = Math.atan2(bogieRise, zB - zF);
  const rocker = wrapPi(Math.atan2(yB - yF, zB - zF) - a0);
  const dz = pivotZ - zF;
  const dy = pivotY - r;
  const pivotWorldY = yF + dz * Math.sin(rocker) + dy * Math.cos(rocker);
  return { bogie, rocker, pivotWorldY };
}

export function createRoverRig(model) {
  const st = {
    init: false, heading: 0, pitch: 0, roll: 0, y: 0, rockers: [0, 0], bogies: [0, 0],
    spin: 0, steer: 0, turnRate: 0, lastHeading: null,
    headYaw: 0, headPitch: 0, glanceYaw: 0, glancePitch: 0, nextGlance: 3, glanceEnd: 0,
    nextBlink: 2.5, blinkUntil: 0, dishAz: 0, dishEl: 0.8, time: 0,
  };
  const color = new THREE.Color();
  const q = new THREE.Quaternion();
  const local = new THREE.Vector3();

  /**
   * pose: { x, z, heading (rad), speed (m/s), groundAt(x,z), earthDir (Vector3), status }
   */
  function update(dt, pose) {
    st.time += dt;
    const { wheelR: r, xw, zF, zM, zR, pivotY } = DIM; // eslint-disable-line no-unused-vars
    if (!st.init) { st.heading = pose.heading; st.lastHeading = pose.heading; }
    const dH = wrapPi(pose.heading - st.lastHeading);
    st.lastHeading = pose.heading;
    st.turnRate = approach(st.turnRate, dt > 0 ? dH / dt : 0, 6, dt);
    st.heading = st.heading + wrapPi(pose.heading - st.heading) * (1 - Math.exp(-14 * dt));

    const c = Math.cos(st.heading), s = Math.sin(st.heading);
    const hub = (lx, lz) => pose.groundAt(pose.x + lx * c + lz * s, pose.z - lx * s + lz * c) + r;
    const solved = [1, -1].map((side) => solveSide(hub(side * xw, zF), hub(side * xw, zM), hub(side * xw, zR)));
    const pitch = (solved[0].rocker + solved[1].rocker) / 2;
    const roll = Math.atan2(solved[0].pivotWorldY - solved[1].pivotWorldY, 2 * DIM.armX);
    const y = (solved[0].pivotWorldY + solved[1].pivotWorldY) / 2 - pivotY;

    const k = st.init ? 16 : 1e6;
    st.pitch = approach(st.pitch, pitch, k, dt || 1);
    st.roll = approach(st.roll, roll, k, dt || 1);
    st.y = approach(st.y, y, k, dt || 1);
    solved.forEach((sv, i) => {
      st.rockers[i] = approach(st.rockers[i], sv.rocker, k, dt || 1);
      st.bogies[i] = approach(st.bogies[i], sv.bogie, k, dt || 1);
    });
    st.init = true;

    model.root.position.set(pose.x, st.y, pose.z);
    model.root.rotation.set(-st.pitch, st.heading, st.roll);

    st.spin += (pose.speed || 0) * dt / r;
    st.steer = approach(st.steer, THREE.MathUtils.clamp(st.turnRate * 1.4, -0.45, 0.45), 8, dt);
    model.sides.forEach((side, i) => {
      side.rocker.rotation.x = -(st.rockers[i] - st.pitch);
      side.bogie.rotation.x = -(st.bogies[i] - st.rockers[i]);
      const [front, , rear] = side.wheels;
      front.steer.rotation.y = st.steer;
      rear.steer.rotation.y = -st.steer;
      for (const w of side.wheels) w.wheel.rotation.x = side.s * st.spin;
    });

    // Head: lead into turns, glance around when idle, blink now and then.
    const moving = Math.abs(pose.speed || 0) > 0.15;
    if (st.time > st.nextGlance) {
      st.glanceYaw = moving ? 0 : (Math.random() - 0.5) * 1.3;
      st.glancePitch = moving ? 0 : (Math.random() - 0.4) * 0.3;
      st.glanceEnd = st.time + 1.2 + Math.random() * 1.2;
      st.nextGlance = st.glanceEnd + 2.5 + Math.random() * 4;
    }
    if (st.time > st.glanceEnd) { st.glanceYaw = 0; st.glancePitch = 0; }
    const yawTarget = THREE.MathUtils.clamp(st.turnRate * 0.9, -0.7, 0.7) + st.glanceYaw;
    const pitchTarget = (moving ? -0.12 : -0.04) + st.glancePitch;
    st.headYaw = approach(st.headYaw, yawTarget, 5, dt);
    st.headPitch = approach(st.headPitch, pitchTarget, 5, dt);
    model.headYaw.rotation.y = st.headYaw;
    model.headPitch.rotation.x = -st.headPitch;
    if (st.time > st.nextBlink) { st.blinkUntil = st.time + 0.13; st.nextBlink = st.time + 2.5 + Math.random() * 4; }
    const lid = st.time < st.blinkUntil ? 0.12 : 1;
    for (const iris of model.irises) iris.scale.y = approach(iris.scale.y, lid, 30, dt);

    // Expression via brows: level when nominal, raised when waiting, knitted on hold.
    const status = pose.status || "nominal";
    for (const b of model.brows) {
      const tilt = status === "hold" ? -0.35 * b.side : status === "waiting" ? 0.12 * b.side : 0;
      const lift = status === "waiting" ? 0.01 : status === "hold" ? -0.006 : 0;
      b.mesh.rotation.z = approach(b.mesh.rotation.z, tilt, 8, dt);
      b.mesh.position.y = approach(b.mesh.position.y, 0.168 + lift, 8, dt);
    }

    // High-gain dish tracks Earth, in the body frame.
    if (pose.earthDir) {
      model.root.updateMatrixWorld();
      model.body.getWorldQuaternion(q).invert();
      local.copy(pose.earthDir).applyQuaternion(q);
      st.dishAz = st.dishAz + wrapPi(Math.atan2(local.x, local.z) - st.dishAz) * (1 - Math.exp(-3 * dt));
      st.dishEl = approach(st.dishEl, Math.asin(THREE.MathUtils.clamp(local.y, -1, 1)), 3, dt);
      model.hgaAz.rotation.y = st.dishAz;
      model.hgaEl.rotation.x = -st.dishEl;
    }

    if (!model.ghost) {
      color.setHex(STATUS_COLORS[status] ?? STATUS_COLORS.nominal);
      const pulse = status === "hold" ? (Math.sin(st.time * 12) > 0 ? 1 : 0.15)
        : status === "waiting" ? 0.55 + 0.45 * Math.sin(st.time * 5) : 0.85 + 0.15 * Math.sin(st.time * 1.5);
      model.statusLight.material.color.copy(color).multiplyScalar(0.35 + 0.9 * pulse);
      if (model.statusGlow) {
        model.statusGlow.material.color.copy(color);
        model.statusGlow.material.opacity = 0.25 + 0.6 * pulse;
      }
    }
  }

  return { update, state: st };
}
