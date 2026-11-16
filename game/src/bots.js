// Bots: the other seven guns in the match. Each bot is an actor with a body in the
// world (legs, torso and head hit meshes), a weapon state shared with the player's
// rules, and a small brain: waypoint navigation over the world's graph, perception
// by sight (field of view plus line of sight) and by hearing gunfire, burst-fire
// discipline with an aim error that shrinks while it stands still, and objective
// play — the Jackals push a site and plant the Charge, the Wardens hold sites,
// rotate on information and defuse. Match.js owns damage and the round clock;
// bots ask it to fire, plant and defuse through the context it passes in.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { WEAPONS, createWeaponState } from './weapons.js';
import { findPath, nearestNode } from './world.js';
import { segmentBlocked } from './player.js';

const RADIUS = 0.34;
const HEIGHT = 1.72;
const EYE = 1.55;
const RUN_SPEED = 5.1;
const WALK_SPEED = 2.6;
const SIGHT_RANGE = 58;
const SIGHT_COS = Math.cos(1.45); // ~83 degrees half-angle
const HEAR_RANGE = 30;

const torsoGeometry = new THREE.BoxGeometry(0.52, 0.72, 0.3);
const headGeometry = new THREE.BoxGeometry(0.27, 0.28, 0.27);
const legGeometry = new THREE.BoxGeometry(0.19, 0.82, 0.22);
const gunGeometry = new THREE.BoxGeometry(0.07, 0.09, 0.62);

export function createBot(scene, team, name, role, rng) {
  const teamColor = team === 'warden' ? PALETTE.warden : PALETTE.jackal;
  const suit = new THREE.MeshStandardMaterial({ color: new THREE.Color(team === 'warden' ? '#2c3e55' : '#552f28'), roughness: 0.85 });
  const vest = new THREE.MeshStandardMaterial({ color: new THREE.Color(teamColor), roughness: 0.6 });
  const skin = new THREE.MeshStandardMaterial({ color: new THREE.Color('#c9a186'), roughness: 0.7 });
  const dark = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.hairline), roughness: 0.8 });

  const group = new THREE.Group();
  const legL = new THREE.Mesh(legGeometry, dark);
  legL.position.set(-0.14, 0.41, 0);
  const legR = new THREE.Mesh(legGeometry, dark);
  legR.position.set(0.14, 0.41, 0);
  const torso = new THREE.Mesh(torsoGeometry, vest);
  torso.position.y = 1.18;
  const hips = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.2, 0.28), suit);
  hips.position.y = 0.78;
  const head = new THREE.Mesh(headGeometry, skin);
  head.position.y = 1.68;
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.29, 0.07, 0.29), vest);
  stripe.position.y = 1.78;
  const gun = new THREE.Mesh(gunGeometry, dark);
  gun.position.set(0.18, 1.32, -0.3);
  group.add(legL, legR, hips, torso, head, stripe, gun);
  group.traverse((mesh) => {
    if (mesh.isMesh) mesh.castShadow = true;
  });
  scene.add(group);

  const bot = {
    isPlayer: false,
    team,
    name,
    role,
    group,
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    yaw: 0,
    health: 100,
    armor: 0,
    alive: true,
    money: 800,
    weapons: { primary: null, secondary: createWeaponState(WEAPONS.sidearm) },
    current: 'secondary',
    grenades: { frag: 0, flash: 0 },
    hasBomb: false,
    crouching: false,
    stepCycle: 0,
    speedNow: 0,
    // brain
    path: [],
    pathIndex: 0,
    goal: null,
    holdPoint: null,
    target: null,
    lastSeenPos: new THREE.Vector3(),
    lastSeenAt: -99,
    acquiredAt: 0,
    burstLeft: 0,
    burstResumeAt: 0,
    nextThinkAt: Math.random() * 0.2,
    nextPathAt: 0,
    channel: null, // { kind: 'plant'|'defuse', left }
    blindUntil: 0,
    fall: 0,
    assignedSite: 'A',
    strafeDir: 1,
    strafeFlipAt: 0,
    rng,
  };
  torso.userData = { actor: bot, part: 'torso' };
  head.userData = { actor: bot, part: 'head' };
  legL.userData = { actor: bot, part: 'legs' };
  legR.userData = { actor: bot, part: 'legs' };
  bot.hitMeshes = [torso, head, legL, legR];

  const probe = new THREE.Box3();
  function blockedAt(x, z, colliders) {
    probe.min.set(x - RADIUS, 0.05, z - RADIUS);
    probe.max.set(x + RADIUS, HEIGHT - 0.05, z + RADIUS);
    for (const collider of colliders) if (probe.intersectsBox(collider)) return true;
    return false;
  }

  // Axis-separated walking, the same resolve the player uses, minus jumping.
  function move(dt, wishX, wishZ, speed, colliders) {
    const len = Math.hypot(wishX, wishZ);
    let vx = 0;
    let vz = 0;
    if (len > 0.001) {
      vx = (wishX / len) * speed;
      vz = (wishZ / len) * speed;
    }
    bot.velocity.x += (vx - bot.velocity.x) * Math.min(1, dt * 10);
    bot.velocity.z += (vz - bot.velocity.z) * Math.min(1, dt * 10);
    const nx = bot.position.x + bot.velocity.x * dt;
    if (!blockedAt(nx, bot.position.z, colliders)) bot.position.x = nx;
    else bot.velocity.x = 0;
    const nz = bot.position.z + bot.velocity.z * dt;
    if (!blockedAt(bot.position.x, nz, colliders)) bot.position.z = nz;
    else bot.velocity.z = 0;
    bot.speedNow = Math.hypot(bot.velocity.x, bot.velocity.z);
    if (bot.speedNow > 0.4) bot.stepCycle += dt * bot.speedNow;
  }

  function setGoal(x, z, ctx) {
    bot.goal = { x, z };
    bot.path = findPath(ctx.nav, bot.position.x, bot.position.z, x, z) ?? [];
    bot.pathIndex = 0;
  }

  function followPath(dt, ctx, speed) {
    if (!bot.goal) return true;
    while (bot.pathIndex < bot.path.length) {
      const node = ctx.nav.nodes[bot.path[bot.pathIndex]];
      if (Math.hypot(node.x - bot.position.x, node.z - bot.position.z) > 0.7) break;
      bot.pathIndex += 1;
    }
    let tx = bot.goal.x;
    let tz = bot.goal.z;
    if (bot.pathIndex < bot.path.length) {
      const node = ctx.nav.nodes[bot.path[bot.pathIndex]];
      tx = node.x;
      tz = node.z;
    }
    const dx = tx - bot.position.x;
    const dz = tz - bot.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.45 && bot.pathIndex >= bot.path.length) {
      move(dt, 0, 0, 0, ctx.colliders);
      return true;
    }
    bot.yaw = turnToward(bot.yaw, Math.atan2(-dx, -dz), dt * 7);
    move(dt, dx, dz, speed, ctx.colliders);
    return false;
  }

  function turnToward(current, targetYaw, maxStep) {
    let diff = targetYaw - current;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const step = Math.max(-maxStep, Math.min(maxStep, diff));
    return current + step;
  }

  const eyePos = new THREE.Vector3();
  const chestPos = new THREE.Vector3();
  function canSee(other, ctx) {
    if (!other.alive) return false;
    const dx = other.position.x - bot.position.x;
    const dz = other.position.z - bot.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist > SIGHT_RANGE) return false;
    if (dist > 7) {
      const facingX = -Math.sin(bot.yaw);
      const facingZ = -Math.cos(bot.yaw);
      if ((dx * facingX + dz * facingZ) / (dist || 1) < SIGHT_COS) return false;
    }
    eyePos.set(bot.position.x, EYE, bot.position.z);
    chestPos.set(other.position.x, other.crouching ? 1.0 : 1.25, other.position.z);
    return !segmentBlocked(eyePos, chestPos, ctx.colliders);
  }

  function think(ctx) {
    // Perception: keep the closest visible enemy; remember where it was.
    let best = null;
    let bestDist = Infinity;
    for (const other of ctx.actors) {
      if (other.team === bot.team || !other.alive) continue;
      const d = Math.hypot(other.position.x - bot.position.x, other.position.z - bot.position.z);
      if (d < bestDist && canSee(other, ctx)) {
        best = other;
        bestDist = d;
      }
    }
    if (best) {
      if (bot.target !== best) {
        bot.target = best;
        bot.acquiredAt = ctx.time;
        bot.burstLeft = 0;
        bot.burstResumeAt = ctx.time + (0.42 - 0.16 * ctx.difficulty) + bot.rng() * 0.18;
      }
      bot.lastSeenPos.copy(best.position);
      bot.lastSeenAt = ctx.time;
    } else if (bot.target && !bot.target.alive) {
      bot.target = null;
    } else if (bot.target && ctx.time - bot.lastSeenAt > 0.4) {
      bot.target = null; // lost sight; lastSeenPos still drives the hunt
    }
    // Hearing: a recent loud noise is remembered as a contact. It never overrides
    // the objective directly — the Wardens' rotation logic reads lastSeenPos, and
    // a bot already hunting a lost target walks toward it.
    const noise = ctx.recentNoise(bot.position, HEAR_RANGE, 1.6);
    if (noise && !best) {
      bot.lastSeenPos.copy(noise);
      bot.lastSeenAt = ctx.time - 0.8; // stale on purpose: a hint, not a track
    }
  }

  function currentWeapon() {
    return bot.weapons[bot.current] ?? bot.weapons.secondary;
  }

  function engage(dt, ctx) {
    const target = bot.target;
    const dx = target.position.x - bot.position.x;
    const dz = target.position.z - bot.position.z;
    const dist = Math.hypot(dx, dz);
    const wantYaw = Math.atan2(-dx, -dz);
    bot.yaw = turnToward(bot.yaw, wantYaw, dt * 10);
    const weapon = currentWeapon();
    const def = weapon.state.def;
    const preferred = def.id === 'scatter' ? 8 : def.id === 'longbow' ? 26 : def.id === 'sidearm' ? 11 : 17;
    // Movement: close the distance when far, strafe in bursts when near, and plant
    // the feet to shoot — a moving bot's aim error balloons, like the player's.
    let wishX = 0;
    let wishZ = 0;
    let speed = 0;
    const shooting = ctx.time >= bot.burstResumeAt && bot.burstLeft > 0;
    if (dist > preferred + 4) {
      wishX = dx;
      wishZ = dz;
      speed = RUN_SPEED;
    } else if (!shooting && dist > 3) {
      if (ctx.time >= bot.strafeFlipAt) {
        bot.strafeDir = bot.rng() < 0.5 ? -1 : 1;
        bot.strafeFlipAt = ctx.time + 0.5 + bot.rng() * 0.9;
      }
      wishX = -dz * bot.strafeDir;
      wishZ = dx * bot.strafeDir;
      speed = WALK_SPEED;
    }
    bot.crouching = false; // holders crouch at their post; fighters stay mobile
    move(dt, wishX, wishZ, speed, ctx.colliders);

    // Fire control: bursts with pauses, a reaction delay on first sight, and a
    // reload when the magazine runs dry (falling back to the sidearm mid-fight).
    // (Weapon cooldowns and reloads tick once per step in bot.step, not here.)
    if (weapon.state.mag === 0 && weapon.state.reloadLeft === 0) {
      if (bot.current === 'primary' && bot.weapons.secondary.state.mag > 0 && dist < 20) {
        bot.current = 'secondary';
      } else {
        weapon.startReload();
      }
      return;
    }
    if (ctx.time < bot.burstResumeAt) return;
    if (bot.burstLeft <= 0) {
      bot.burstLeft = def.auto ? 3 + Math.floor(bot.rng() * 3) : 1;
      if (ctx.time < bot.acquiredAt + 0.15) return;
    }
    if (!weapon.canFire()) return;
    weapon.fire();
    bot.burstLeft -= 1;
    if (bot.burstLeft <= 0) bot.burstResumeAt = ctx.time + 0.38 + bot.rng() * 0.5;
    // Aim: chest, or head for the longbow at range; error shrinks the longer the
    // bot has been still and grows with both parties' movement.
    const aimY = def.id === 'longbow' && dist > 18 ? 1.52 : 1.18;
    const stillness = Math.max(0, 1 - bot.speedNow / RUN_SPEED);
    const baseError = (0.052 - 0.03 * ctx.difficulty) * (1.15 - 0.75 * stillness);
    const targetSpeed = target.isPlayer ? target.speedNow ?? 0 : target.speedNow;
    const error = baseError + targetSpeed * 0.004 + dist * 0.0004;
    const dir = new THREE.Vector3(
      target.position.x - bot.position.x + (bot.rng() * 2 - 1) * error * dist,
      aimY - EYE + (bot.rng() * 2 - 1) * error * dist * 0.7,
      target.position.z - bot.position.z + (bot.rng() * 2 - 1) * error * dist,
    ).normalize();
    eyePos.set(bot.position.x, EYE + 0.12, bot.position.z);
    ctx.fireHitscan(bot, eyePos, dir, 0.002);
    ctx.noise(bot.position, 26);
  }

  function objective(dt, ctx) {
    const bomb = ctx.bomb;
    if (bot.channel) {
      // Planting or defusing: stand still and channel; a visible enemy interrupts.
      move(dt, 0, 0, 0, ctx.colliders);
      if (bot.target) {
        bot.channel = null;
        return;
      }
      bot.channel.left -= dt;
      if (bot.channel.left <= 0) {
        const kind = bot.channel.kind;
        bot.channel = null;
        if (kind === 'plant') ctx.tryPlant(bot);
        else ctx.tryDefuse(bot);
      }
      return;
    }
    if (bot.team === 'jackal') {
      if (bomb.planted) {
        // Guard the planted Charge from nearby cover.
        const guard = ctx.guardPoint(bot, bomb.site);
        if (!bot.goal || Math.hypot(bot.goal.x - guard.x, bot.goal.z - guard.z) > 0.5) setGoal(guard.x, guard.z, ctx);
        followPath(dt, ctx, RUN_SPEED);
        return;
      }
      if (bot.hasBomb) {
        const site = ctx.sites[bot.assignedSite];
        const d = Math.hypot(site.x - bot.position.x, site.z - bot.position.z);
        if (d < 2.4) {
          bot.channel = { kind: 'plant', left: 3.2 };
          ctx.onChannelStart(bot, 'plant');
          return;
        }
        if (!bot.goal || Math.hypot(bot.goal.x - site.x, bot.goal.z - site.z) > 1) setGoal(site.x, site.z, ctx);
        followPath(dt, ctx, d < 8 ? WALK_SPEED + 1 : RUN_SPEED);
        return;
      }
      if (bomb.carrierDown) {
        // The Charge is on the ground: the nearest Jackal goes to fetch it.
        if (ctx.nearestCarrierCandidate(bot)) {
          if (!bot.goal || Math.hypot(bot.goal.x - bomb.groundPos.x, bot.goal.z - bomb.groundPos.z) > 1) setGoal(bomb.groundPos.x, bomb.groundPos.z, ctx);
          followPath(dt, ctx, RUN_SPEED);
          return;
        }
      }
      // Escort: move with the carrier toward the assigned site, a few metres off.
      const escort = ctx.escortPoint(bot);
      if (!bot.goal || Math.hypot(bot.goal.x - escort.x, bot.goal.z - escort.z) > 1.5) setGoal(escort.x, escort.z, ctx);
      followPath(dt, ctx, RUN_SPEED);
      return;
    }
    // Wardens.
    if (bomb.planted) {
      const d = Math.hypot(bomb.position.x - bot.position.x, bomb.position.z - bot.position.z);
      if (d < 1.9) {
        bot.channel = { kind: 'defuse', left: 5 };
        ctx.onChannelStart(bot, 'defuse');
        return;
      }
      if (!bot.goal || Math.hypot(bot.goal.x - bomb.position.x, bot.goal.z - bomb.position.z) > 1) setGoal(bomb.position.x, bomb.position.z, ctx);
      followPath(dt, ctx, RUN_SPEED);
      return;
    }
    if (ctx.time - bot.lastSeenAt < 5 && bot.lastSeenPos.lengthSq() > 0) {
      // Rotate toward the last contact.
      if (!bot.goal || Math.hypot(bot.goal.x - bot.lastSeenPos.x, bot.goal.z - bot.lastSeenPos.z) > 2) setGoal(bot.lastSeenPos.x, bot.lastSeenPos.z, ctx);
      followPath(dt, ctx, RUN_SPEED);
      return;
    }
    const hold = bot.holdPoint ?? ctx.holdPointFor(bot);
    bot.holdPoint = hold;
    const arrived = followPath(dt, ctx, RUN_SPEED);
    if (arrived) {
      // Hold the angle: face the approach, shift weight now and then.
      bot.yaw = turnToward(bot.yaw, hold.yaw, dt * 3);
      bot.crouching = hold.crouch ?? false;
    }
  }

  bot.step = function step(dt, ctx) {
    if (!bot.alive) {
      bot.fall = Math.min(1, bot.fall + dt / 0.38);
      group.rotation.x = -bot.fall * 1.5;
      group.position.y = -bot.fall * 0.12;
      return;
    }
    group.position.copy(bot.position);
    group.rotation.set(0, bot.yaw, 0);
    const swing = Math.sin(bot.stepCycle * 2.1) * (bot.speedNow > 0.3 ? 0.5 : 0);
    legL.rotation.x = swing;
    legR.rotation.x = -swing;
    const crouchDip = bot.crouching ? 0.34 : 0;
    torso.position.y = 1.18 - crouchDip;
    head.position.y = 1.68 - crouchDip;
    stripe.position.y = 1.78 - crouchDip;
    gun.position.y = 1.32 - crouchDip;
    legL.position.y = 0.41 - crouchDip * 0.4;
    legR.position.y = 0.41 - crouchDip * 0.4;

    for (const weapon of Object.values(bot.weapons)) weapon?.step(dt);
    if (ctx.phase !== 'live' && ctx.phase !== 'planted') return;
    if (ctx.time >= bot.nextThinkAt) {
      bot.nextThinkAt = ctx.time + 0.12;
      think(ctx);
    }
    if (ctx.time < bot.blindUntil) {
      move(dt, 0, 0, 0, ctx.colliders);
      return;
    }
    if (bot.target && bot.target.alive && ctx.time - bot.lastSeenAt < 0.45) engage(dt, ctx);
    else objective(dt, ctx);
  };

  bot.reset = function reset(x, z, yaw) {
    bot.position.set(x, 0, z);
    bot.velocity.set(0, 0, 0);
    bot.yaw = yaw;
    bot.health = 100;
    bot.alive = true;
    bot.fall = 0;
    bot.target = null;
    bot.channel = null;
    bot.goal = null;
    bot.path = [];
    bot.pathIndex = 0;
    bot.lastSeenAt = -99;
    bot.blindUntil = 0;
    bot.crouching = false;
    bot.hasBomb = false;
    group.rotation.set(0, yaw, 0);
    group.position.set(x, 0, z);
  };

  bot.equip = function equip(weaponId) {
    bot.weapons.primary = createWeaponState(WEAPONS[weaponId]);
    bot.current = 'primary';
  };

  return bot;
}
