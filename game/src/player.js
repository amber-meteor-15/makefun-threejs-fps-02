// The human player's body: acceleration and friction on the ground, weak air control,
// crouch and jump, resolved as a box against the world's colliders one axis at a time
// so a wall never swallows the player. Walking (Shift) is slower and silent; running
// is loud and inaccurate — the accuracy model in match.js reads groundSpeed().
import * as THREE from 'three';

const RADIUS = 0.34;
const STAND_HEIGHT = 1.72;
const CROUCH_HEIGHT = 1.14;
const STAND_EYE = 1.6;
const CROUCH_EYE = 1.04;
const RUN_SPEED = 5.4;
const WALK_SPEED = 2.7;
const CROUCH_SPEED = 2.3;
const GROUND_ACCEL = 46;
const AIR_ACCEL = 8;
const FRICTION = 10;
const GRAVITY = 21;
const JUMP_SPEED = 6.4;

export function createPlayer(colliders) {
  const player = {
    position: new THREE.Vector3(0, 0, -19),
    velocity: new THREE.Vector3(),
    yaw: Math.PI, // facing +z, toward the yard from the north spawn
    pitch: 0,
    eye: STAND_EYE,
    onGround: true,
    crouching: false,
    walking: false,
    height: STAND_HEIGHT,
    stepCycle: 0, // drives footstep sounds and view bob
  };
  const probe = new THREE.Box3();
  const wish = new THREE.Vector3();

  // lift keeps the feet and the crown out of the horizontal tests, so standing on the
  // floor is not read as walking into a wall.
  function overlaps(x, y, z, height, lift) {
    probe.min.set(x - RADIUS, y + lift, z - RADIUS);
    probe.max.set(x + RADIUS, y + height - lift, z + RADIUS);
    for (const collider of colliders) if (probe.intersectsBox(collider)) return collider;
    return null;
  }

  function look(dx, dy, sensitivity = 0.0021) {
    player.yaw -= dx * sensitivity;
    player.pitch = Math.max(-1.45, Math.min(1.45, player.pitch - dy * sensitivity));
  }

  function recoil(pitchKick, yawKick) {
    player.pitch = Math.min(1.45, player.pitch + pitchKick);
    player.yaw += yawKick;
  }

  function teleport(x, z, yaw) {
    player.position.set(x, 0, z);
    player.velocity.set(0, 0, 0);
    player.yaw = yaw;
    player.pitch = 0;
  }

  function step(dt, keys) {
    const wantCrouch = keys.has('ControlLeft') || keys.has('ControlRight') || keys.has('KeyC');
    if (wantCrouch && !player.crouching) {
      player.crouching = true;
      player.height = CROUCH_HEIGHT;
    } else if (!wantCrouch && player.crouching && !overlaps(player.position.x, player.position.y, player.position.z, STAND_HEIGHT, 0.02)) {
      player.crouching = false;
      player.height = STAND_HEIGHT;
    }
    const eyeTarget = player.crouching ? CROUCH_EYE : STAND_EYE;
    player.eye += (eyeTarget - player.eye) * Math.min(1, dt * 12);
    player.walking = (keys.has('ShiftLeft') || keys.has('ShiftRight')) && !player.crouching;

    const forward = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    const strafe = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    wish.set(0, 0, 0);
    if (forward || strafe) {
      const sin = Math.sin(player.yaw);
      const cos = Math.cos(player.yaw);
      wish.set(-sin * forward + cos * strafe, 0, -cos * forward - sin * strafe).normalize();
    }

    const speed = player.crouching ? CROUCH_SPEED : player.walking ? WALK_SPEED : RUN_SPEED;
    const blend = Math.min(1, (player.onGround ? GROUND_ACCEL : AIR_ACCEL) * dt / speed);
    player.velocity.x += (wish.x * speed - player.velocity.x) * blend;
    player.velocity.z += (wish.z * speed - player.velocity.z) * blend;
    if (player.onGround && !wish.lengthSq()) {
      const damp = Math.max(0, 1 - FRICTION * dt);
      player.velocity.x *= damp;
      player.velocity.z *= damp;
    }

    if (keys.has('Space') && player.onGround) {
      player.velocity.y = JUMP_SPEED;
      player.onGround = false;
    }
    player.velocity.y -= GRAVITY * dt;

    const nextX = player.position.x + player.velocity.x * dt;
    if (!overlaps(nextX, player.position.y, player.position.z, player.height, 0.04)) player.position.x = nextX;
    else player.velocity.x = 0;
    const nextZ = player.position.z + player.velocity.z * dt;
    if (!overlaps(player.position.x, player.position.y, nextZ, player.height, 0.04)) player.position.z = nextZ;
    else player.velocity.z = 0;

    player.position.y += player.velocity.y * dt;
    player.onGround = false;
    const hit = overlaps(player.position.x, player.position.y, player.position.z, player.height, 0);
    if (hit && player.velocity.y <= 0) {
      player.position.y = hit.max.y;
      player.velocity.y = 0;
      player.onGround = true;
    } else if (hit) {
      player.position.y = hit.min.y - player.height;
      player.velocity.y = 0;
    }
    if (player.position.y < 0) {
      player.position.y = 0;
      player.velocity.y = 0;
      player.onGround = true;
    }
    player.velocity.y = Math.max(-30, player.velocity.y);

    const speedNow = Math.hypot(player.velocity.x, player.velocity.z);
    if (player.onGround && speedNow > 0.4) player.stepCycle += dt * speedNow;
  }

  return {
    state: player,
    step,
    look,
    recoil,
    teleport,
    groundSpeed() {
      return Math.hypot(player.velocity.x, player.velocity.z);
    },
  };
}

// Segment versus the AABB colliders, slab method: true when the segment from a to b
// touches any collider. Shared by bot line-of-sight and grenade blast checks, which
// run far too often to afford a scene raycast.
export function segmentBlocked(a, b, colliders) {
  for (const box of colliders) {
    if (segmentIntersectsBox(a, b, box)) return true;
  }
  return false;
}

export function segmentIntersectsBox(a, b, box) {
  let tMin = 0;
  let tMax = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  // X slab
  if (Math.abs(dx) < 1e-9) {
    if (a.x < box.min.x || a.x > box.max.x) return false;
  } else {
    let t1 = (box.min.x - a.x) / dx;
    let t2 = (box.max.x - a.x) / dx;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return false;
  }
  // Y slab
  if (Math.abs(dy) < 1e-9) {
    if (a.y < box.min.y || a.y > box.max.y) return false;
  } else {
    let t1 = (box.min.y - a.y) / dy;
    let t2 = (box.max.y - a.y) / dy;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return false;
  }
  // Z slab
  if (Math.abs(dz) < 1e-9) {
    if (a.z < box.min.z || a.z > box.max.z) return false;
  } else {
    let t1 = (box.min.z - a.z) / dz;
    let t2 = (box.max.z - a.z) / dz;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return false;
  }
  return true;
}
