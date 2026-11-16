// The match: two teams of four, a round clock, an economy, and the Charge.
// Wardens (the player's team) defend two plant sites; Jackals attack with the
// bomb. Rounds run buy/freeze, live, planted and round-end phases; first to 9
// round wins takes the match, at most 16 rounds. This module owns every actor,
// all damage, grenades, the bomb, tracers and impact effects, and the context
// the bots think with. It never touches the DOM: main.js renders the HUD from
// getSnapshot() and the events emitted here.
import * as THREE from 'three';
import { WEAPONS, GRENADE_DEFS, ARMOR_PRICE, MAX_MONEY, createWeaponState, falloff, spreadFor } from './weapons.js';
import { createBot } from './bots.js';
import { segmentBlocked } from './player.js';

export const BUY_TIME = 12;
export const ROUND_TIME = 100;
export const BOMB_TIME = 40;
export const ROUND_END_TIME = 5;
export const WIN_ROUNDS = 9;
export const MAX_ROUNDS = 16;
export const KILL_REWARD = 300;
export const WIN_REWARD = 1400;
export const LOSS_REWARD = 1000;
export const PLANT_TIME = 3.2;
export const DEFUSE_TIME = 5;

const WARDEN_NAMES = ['Vex', 'Ondo', 'Pell'];
const JACKAL_NAMES = ['Rurik', 'Sable', 'Kitt', 'Moss'];
const GUARD_POINTS = {
  A: [[-21, -11], [-31, -11], [-19, -18.5]],
  B: [[21, -11], [31, -11], [19, -18.5]],
};
const HOLD_POINTS = [
  { x: -19, z: -17, lookX: -24, lookZ: -5, crouch: true },
  { x: -17, z: -12.5, lookX: -15, lookZ: 2, crouch: false },
  { x: 19, z: -17, lookX: 24, lookZ: -5, crouch: true },
  { x: 17, z: -12.5, lookX: 15, lookZ: 2, crouch: false },
];

export function yawFor(dx, dz) {
  return Math.atan2(-dx, -dz);
}

export function createMatch({ scene, world, audio, playerCtrl, emit, rng }) {
  const raycaster = new THREE.Raycaster();
  const playerBody = playerCtrl.state;

  const playerActor = {
    isPlayer: true,
    team: 'warden',
    name: 'You',
    position: playerBody.position,
    health: 100,
    armor: 0,
    alive: true,
    money: 800,
    weapons: { primary: null, secondary: createWeaponState(WEAPONS.sidearm) },
    current: 'secondary',
    grenades: { frag: 0, flash: 0 },
    kills: 0,
    deaths: 0,
    hasBomb: false,
    get crouching() { return playerBody.crouching; },
    get speedNow() { return playerCtrl.groundSpeed(); },
    get yaw() { return playerBody.yaw; },
  };

  const bots = [];
  WARDEN_NAMES.forEach((name, i) => bots.push(createBot(scene, 'warden', name, i === 0 ? 'holder' : 'rifle', rng)));
  JACKAL_NAMES.forEach((name, i) => bots.push(createBot(scene, 'jackal', name, i === 0 ? 'planter' : i === 3 ? 'marksman' : 'rifle', rng)));
  const actors = [playerActor, ...bots];

  // Bot muzzle flashes: a small additive plane on each gun, lit by match on fire.
  const flashMaterial = new THREE.MeshBasicMaterial({ color: 0xffb35c, transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide });
  const flashGeometry = new THREE.PlaneGeometry(0.34, 0.34);
  for (const bot of bots) {
    const flash = new THREE.Mesh(flashGeometry, flashMaterial);
    flash.position.set(0.18, 1.32, -0.68);
    flash.visible = false;
    bot.group.add(flash);
    bot.muzzleFlash = flash;
    bot.flashLeft = 0;
  }

  const hitTargets = [...world.shootables];
  for (const bot of bots) hitTargets.push(...bot.hitMeshes);

  const bombMesh = new THREE.Group();
  const bombBody = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.22, 0.26), new THREE.MeshStandardMaterial({ color: 0x2c2c30, roughness: 0.5, metalness: 0.4 }));
  const bombLightMesh = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.05, 0.08), new THREE.MeshBasicMaterial({ color: 0xff4040 }));
  bombLightMesh.position.y = 0.14;
  bombMesh.add(bombBody, bombLightMesh);
  bombMesh.visible = false;
  scene.add(bombMesh);

  const match = {
    phase: 'buy',
    phaseLeft: BUY_TIME,
    time: 0,
    round: 0,
    score: { warden: 0, jackal: 0 },
    winner: null,
    winReason: '',
    defuseProgress: 0,
    defusing: false,
    lastBeepAt: 0,
    difficulty: 1,
  };
  const bomb = {
    state: 'carried', // carried | ground | planted | done
    carrier: null,
    groundPos: new THREE.Vector3(),
    planted: false,
    site: null,
    position: new THREE.Vector3(),
    timer: 0,
  };
  const noises = [];
  const grenades = [];
  const effects = [];

  // --- Effects pools ---------------------------------------------------------
  const tracerMaterial = new THREE.LineBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.75 });
  const tracers = [];
  for (let i = 0; i < 24; i += 1) {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const line = new THREE.Line(geo, tracerMaterial);
    line.visible = false;
    line.frustumCulled = false;
    scene.add(line);
    tracers.push({ line, life: 0 });
  }
  const puffGeometry = new THREE.OctahedronGeometry(0.09);
  const puffMaterials = {
    dust: new THREE.MeshBasicMaterial({ color: 0xb9a888, transparent: true }),
    blood: new THREE.MeshBasicMaterial({ color: 0xc62f3b, transparent: true }),
    spark: new THREE.MeshBasicMaterial({ color: 0xffc46b, transparent: true }),
  };
  const puffs = [];
  for (let i = 0; i < 28; i += 1) {
    const mesh = new THREE.Mesh(puffGeometry, puffMaterials.dust);
    mesh.visible = false;
    scene.add(mesh);
    puffs.push({ mesh, life: 0, max: 0.3, vel: new THREE.Vector3() });
  }
  const blastMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 12), new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0, depthWrite: false }));
  blastMesh.visible = false;
  scene.add(blastMesh);
  const blastLight = new THREE.PointLight(0xff9040, 0, 26);
  scene.add(blastLight);
  const blast = { life: 0, radius: 5 };

  const tmpDir = new THREE.Vector3();
  const tmpOrigin = new THREE.Vector3();
  const tmpPoint = new THREE.Vector3();
  const playerSphere = new THREE.Sphere(new THREE.Vector3(), 0.36);
  const ray = new THREE.Ray();

  function spawnTracer(from, to) {
    const t = tracers.find((item) => item.life <= 0) ?? tracers[0];
    const pos = t.line.geometry.attributes.position;
    pos.setXYZ(0, from.x, from.y, from.z);
    pos.setXYZ(1, to.x, to.y, to.z);
    pos.needsUpdate = true;
    t.line.visible = true;
    t.life = 0.07;
  }
  function spawnPuff(point, kind, count = 3) {
    for (let i = 0; i < count; i += 1) {
      const p = puffs.find((item) => item.life <= 0);
      if (!p) return;
      p.mesh.material = puffMaterials[kind];
      p.mesh.position.copy(point);
      p.vel.set((rng() - 0.5) * 1.6, rng() * 1.8 + 0.4, (rng() - 0.5) * 1.6);
      p.life = p.max = 0.22 + rng() * 0.15;
      p.mesh.visible = true;
      p.mesh.scale.setScalar(0.7 + rng() * 0.8);
    }
  }

  function noise(pos, radius) {
    noises.push({ x: pos.x, z: pos.z, at: match.time, radius });
    if (noises.length > 24) noises.shift();
  }

  // --- Damage ------------------------------------------------------------------
  function applyDamage(attacker, victim, def, part, distance, point) {
    let damage = def.damage * falloff(def, distance);
    if (part === 'head') damage *= def.headMult;
    else if (part === 'legs') damage *= def.legMult;
    if (victim.armor > 0) {
      const absorbed = Math.min(victim.armor, damage * 0.5);
      victim.armor -= absorbed;
      damage -= absorbed;
    }
    victim.health -= damage;
    if (point) spawnPuff(point, 'blood', part === 'head' ? 5 : 3);
    if (attacker.isPlayer) emit({ type: 'hitConfirm', killed: victim.health <= 0, headshot: part === 'head' });
    if (victim.isPlayer) {
      emit({ type: 'playerHurt', damage, fromPos: attacker.position });
      audio.hurt();
    }
    if (victim.health <= 0 && victim.alive) kill(attacker, victim, def, part === 'head');
  }

  function kill(attacker, victim, def, headshot) {
    victim.alive = false;
    victim.health = 0;
    victim.deaths = (victim.deaths ?? 0) + 1;
    if (attacker && attacker !== victim) {
      attacker.kills = (attacker.kills ?? 0) + 1;
      attacker.money = Math.min(MAX_MONEY, attacker.money + KILL_REWARD);
    }
    emit({ type: 'killfeed', killer: attacker ? attacker.name : '—', killerTeam: attacker ? attacker.team : null, victim: victim.name, victimTeam: victim.team, weapon: def ? def.name : 'Frag Grenade', headshot: !!headshot });
    if (victim.hasBomb) {
      victim.hasBomb = false;
      bomb.state = 'ground';
      bomb.carrier = null;
      bomb.groundPos.copy(victim.position);
      bombMesh.visible = true;
      bombMesh.position.set(victim.position.x, 0.12, victim.position.z);
      emit({ type: 'notice', text: 'The Charge is down' });
    }
    if (victim.isPlayer) emit({ type: 'playerDeath', killer: attacker ? attacker.name : '—' });
    checkRoundEnd();
  }

  function teamAlive(team) {
    return actors.filter((a) => a.team === team && a.alive);
  }

  function checkRoundEnd() {
    if (match.phase !== 'live' && match.phase !== 'planted') return;
    const wardens = teamAlive('warden').length;
    const jackals = teamAlive('jackal').length;
    if (wardens === 0) endRound('jackal', bomb.planted ? 'The Wardens are eliminated' : 'elimination');
    else if (jackals === 0 && !bomb.planted) endRound('warden', 'elimination');
  }

  function endRound(winnerTeam, reason) {
    if (match.phase === 'roundEnd' || match.phase === 'matchEnd') return;
    match.phase = 'roundEnd';
    match.phaseLeft = ROUND_END_TIME;
    match.score[winnerTeam] += 1;
    for (const actor of actors) {
      actor.money = Math.min(MAX_MONEY, actor.money + (actor.team === winnerTeam ? WIN_REWARD : LOSS_REWARD));
    }
    const playerWon = winnerTeam === 'warden';
    emit({ type: 'roundEnd', winner: winnerTeam, reason, score: { ...match.score } });
    if (playerWon) audio.roundWin();
    else audio.roundLose();
    if (bomb.state === 'planted') bomb.state = 'done';
  }

  // --- Shooting ------------------------------------------------------------------
  function jitter(dir, cone) {
    tmpDir.copy(dir);
    if (cone <= 0) return tmpDir;
    tmpDir.x += (rng() * 2 - 1) * cone;
    tmpDir.y += (rng() * 2 - 1) * cone;
    tmpDir.z += (rng() * 2 - 1) * cone;
    return tmpDir.normalize();
  }

  // One trigger pull from any actor. extraSpread is the shooter's inaccuracy cone
  // (movement/bloom for the player, aim error for a bot); pellets each draw their
  // own ray inside it. Returns true when a round actually left the barrel.
  function fireHitscan(shooter, origin, dir, extraSpread) {
    const weapon = shooter.weapons[shooter.current] ?? shooter.weapons.secondary;
    const def = weapon.state.def;
    const distToPlayer = shooter.isPlayer ? 0 : Math.hypot(playerBody.position.x - shooter.position.x, playerBody.position.z - shooter.position.z);
    audio.shot(def.sound, distToPlayer);
    noise(shooter.position, 26);
    if (shooter.muzzleFlash) shooter.flashLeft = 0.05;
    for (let pellet = 0; pellet < def.pellets; pellet += 1) {
      const cone = extraSpread + (def.pellets > 1 ? def.spreadStill * 0.8 : 0);
      const d = jitter(dir, cone);
      raycaster.set(origin, d);
      raycaster.far = def.range;
      const hits = raycaster.intersectObjects(hitTargets, false);
      let bestDist = Infinity;
      let bestHit = null;
      for (const hit of hits) {
        if (hit.object.userData.actor === shooter) continue; // never shoot yourself
        if (hit.distance < 0.7 && hit.object.userData.actor) continue; // a teammate at the muzzle
        bestDist = hit.distance;
        bestHit = hit;
        break;
      }
      // The player has no meshes: test the ray against three body spheres.
      if (!shooter.isPlayer && playerActor.alive) {
        ray.set(origin, d);
        const crouch = playerBody.crouching;
        const parts = [
          ['head', playerBody.position.y + (crouch ? 1.28 : 1.6), 0.17],
          ['torso', playerBody.position.y + (crouch ? 0.95 : 1.22), 0.37],
          ['legs', playerBody.position.y + 0.45, 0.34],
        ];
        for (const [part, height, radius] of parts) {
          playerSphere.center.set(playerBody.position.x, height, playerBody.position.z);
          playerSphere.radius = radius;
          const at = ray.intersectSphere(playerSphere, tmpPoint);
          if (at) {
            const dist = tmpPoint.distanceTo(origin);
            if (dist < bestDist) {
              bestDist = dist;
              bestHit = { object: null, part, point: tmpPoint.clone(), distance: dist };
            }
          }
        }
      }
      tmpOrigin.copy(origin).addScaledVector(d, 0.55);
      tmpOrigin.y -= 0.06;
      if (bestHit) {
        spawnTracer(tmpOrigin, bestHit.point);
        if (bestHit.object) {
          const { actor, part } = bestHit.object.userData;
          if (actor && actor.alive) applyDamage(shooter, actor, def, part, bestHit.distance, bestHit.point);
          else spawnPuff(bestHit.point, 'spark', 2);
        } else {
          applyDamage(shooter, playerActor, def, bestHit.part, bestHit.distance, bestHit.point);
        }
      } else {
        tmpPoint.copy(origin).addScaledVector(d, def.range * 0.6);
        spawnTracer(tmpOrigin, tmpPoint);
      }
    }
    return true;
  }

  // --- Grenades ------------------------------------------------------------------
  const grenadeGeometry = new THREE.SphereGeometry(0.09, 12, 9);
  const grenadeMaterials = {
    frag: new THREE.MeshStandardMaterial({ color: 0x4a5548, roughness: 0.6 }),
    flash: new THREE.MeshStandardMaterial({ color: 0xb9c2c9, roughness: 0.35, metalness: 0.5 }),
  };
  function throwGrenade(actor, kind, origin, dir) {
    const mesh = new THREE.Mesh(grenadeGeometry, grenadeMaterials[kind]);
    mesh.position.copy(origin);
    scene.add(mesh);
    const vel = dir.clone().multiplyScalar(13.5);
    vel.y += 2.4;
    if (!actor.isPlayer) vel.multiplyScalar(0.8);
    grenades.push({ kind, actor, mesh, vel, fuse: GRENADE_DEFS[kind].fuse, spin: rng() * 6 });
    audio.throwWhoosh();
  }

  function detonate(grenade) {
    const pos = grenade.mesh.position;
    const def = GRENADE_DEFS[grenade.kind];
    scene.remove(grenade.mesh);
    if (grenade.kind === 'frag') {
      blast.life = 0.45;
      blast.radius = def.radius;
      blastMesh.position.copy(pos);
      blastLight.position.copy(pos);
      blastLight.intensity = 60;
      audio.explosion(Math.hypot(playerBody.position.x - pos.x, playerBody.position.z - pos.z));
      for (const actor of actors) {
        if (!actor.alive) continue;
        const centre = tmpPoint.set(actor.position.x, actor.position.y + 1, actor.position.z);
        const dist = centre.distanceTo(pos);
        if (dist > def.radius + 0.5) continue;
        const blocked = segmentBlocked(pos, centre, world.colliders);
        let damage = def.maxDamage * Math.max(0.12, 1 - dist / (def.radius + 0.5));
        if (blocked) damage *= 0.25;
        if (actor.armor > 0) {
          const absorbed = Math.min(actor.armor, damage * 0.5);
          actor.armor -= absorbed;
          damage -= absorbed;
        }
        actor.health -= damage;
        if (actor.isPlayer) {
          emit({ type: 'playerHurt', damage, fromPos: pos });
          audio.hurt();
        }
        if (actor.health <= 0 && actor.alive) kill(grenade.actor, actor, null, false);
      }
    } else {
      audio.flashPop(Math.hypot(playerBody.position.x - pos.x, playerBody.position.z - pos.z));
      blast.life = 0.3;
      blast.radius = 2.5;
      blastMesh.position.copy(pos);
      blastLight.position.copy(pos);
      blastLight.intensity = 40;
      for (const actor of actors) {
        if (!actor.alive) continue;
        const dx = pos.x - actor.position.x;
        const dz = pos.z - actor.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist > def.radius) continue;
        tmpPoint.set(actor.position.x, actor.position.y + 1.4, actor.position.z);
        if (segmentBlocked(tmpPoint, pos, world.colliders)) continue;
        const facingX = -Math.sin(actor.yaw ?? 0);
        const facingZ = -Math.cos(actor.yaw ?? 0);
        const dot = dist > 0.01 ? (dx * facingX + dz * facingZ) / dist : 1;
        const facingFactor = dot > 0.5 ? 1 : dot > -0.2 ? 0.55 : 0.18;
        const strength = Math.max(0, 1 - dist / def.radius) * facingFactor;
        if (strength <= 0.05) continue;
        if (actor.isPlayer) emit({ type: 'playerFlashed', strength, duration: def.maxBlind * strength + 0.4 });
        else actor.blindUntil = Math.max(actor.blindUntil, match.time + def.maxBlind * strength);
      }
    }
  }

  function stepGrenades(dt) {
    for (let i = grenades.length - 1; i >= 0; i -= 1) {
      const g = grenades[i];
      g.fuse -= dt;
      g.vel.y -= 16 * dt;
      const pos = g.mesh.position;
      // Move axis by axis; a blocked axis bounces with lost energy.
      for (const axis of ['x', 'y', 'z']) {
        const next = pos[axis] + g.vel[axis] * dt;
        const probe = tmpPoint.copy(pos);
        probe[axis] = next;
        let blocked = probe.y < 0.09;
        if (!blocked) {
          for (const box of world.colliders) {
            if (probe.x > box.min.x - 0.08 && probe.x < box.max.x + 0.08 && probe.y > box.min.y - 0.08 && probe.y < box.max.y + 0.08 && probe.z > box.min.z - 0.08 && probe.z < box.max.z + 0.08) {
              blocked = true;
              break;
            }
          }
        }
        if (blocked) {
          g.vel[axis] *= -0.38;
          if (axis === 'y' && Math.abs(g.vel.y) < 0.8) g.vel.y = 0;
        } else {
          pos[axis] = next;
        }
      }
      if (pos.y <= 0.1) {
        pos.y = 0.09;
        g.vel.x *= 0.8;
        g.vel.z *= 0.8;
      }
      g.mesh.rotation.x += g.spin * dt;
      if (g.fuse <= 0) {
        detonate(g);
        grenades.splice(i, 1);
      }
    }
  }

  // --- The bomb -------------------------------------------------------------------
  function tryPlant(bot) {
    if (match.phase !== 'live' || !bot.hasBomb) return;
    const site = world.sites[bot.assignedSite];
    if (Math.hypot(site.x - bot.position.x, site.z - bot.position.z) > site.radius) return;
    bot.hasBomb = false;
    bomb.state = 'planted';
    bomb.planted = true;
    bomb.site = bot.assignedSite;
    bomb.position.set(bot.position.x, 0, bot.position.z);
    bomb.timer = BOMB_TIME;
    match.phase = 'planted';
    match.phaseLeft = BOMB_TIME;
    match.lastBeepAt = match.time;
    bombMesh.visible = true;
    bombMesh.position.set(bot.position.x, 0.12, bot.position.z);
    bot.money = Math.min(MAX_MONEY, bot.money + 300);
    audio.plantDone();
    emit({ type: 'planted', site: bomb.site });
  }

  function tryDefuse(actor) {
    if (!bomb.planted) return;
    bomb.planted = false;
    bomb.state = 'done';
    bombMesh.visible = false;
    actor.money = Math.min(MAX_MONEY, actor.money + 300);
    emit({ type: 'defused', by: actor.name });
    endRound('warden', 'The Charge is defused');
  }

  function explodeBomb() {
    blast.life = 0.8;
    blast.radius = 9;
    blastMesh.position.set(bomb.position.x, 1, bomb.position.z);
    blastLight.position.copy(blastMesh.position);
    blastLight.intensity = 120;
    audio.explosion(Math.hypot(playerBody.position.x - bomb.position.x, playerBody.position.z - bomb.position.z));
    for (const actor of actors) {
      if (!actor.alive) continue;
      const dist = Math.hypot(actor.position.x - bomb.position.x, actor.position.z - bomb.position.z);
      if (dist < 7) {
        actor.health = 0;
        kill(null, actor, null, false);
      }
    }
    bomb.planted = false;
    bomb.state = 'done';
    bombMesh.visible = false;
    endRound('jackal', 'The Charge detonates');
  }

  // --- Bot context ------------------------------------------------------------------
  const botCtx = {
    actors,
    nav: world.nav,
    colliders: world.colliders,
    sites: world.sites,
    get time() { return match.time; },
    get phase() { return match.phase; },
    get difficulty() { return match.difficulty; },
    bomb: {
      get planted() { return bomb.planted; },
      get site() { return bomb.site; },
      get position() { return bomb.position; },
      get carrierDown() { return bomb.state === 'ground'; },
      get groundPos() { return bomb.groundPos; },
    },
    fireHitscan,
    noise,
    recentNoise(pos, range, within) {
      for (let i = noises.length - 1; i >= 0; i -= 1) {
        const n = noises[i];
        if (match.time - n.at > within) continue;
        if (Math.hypot(n.x - pos.x, n.z - pos.z) < Math.min(range, n.radius + 6)) return n;
      }
      return null;
    },
    tryPlant,
    tryDefuse,
    onChannelStart(bot, kind) {
      emit({ type: 'channel', who: bot.name, kind });
      if (kind === 'plant') audio.beep();
    },
    guardPoint(bot, siteId) {
      const points = GUARD_POINTS[siteId];
      const idx = bots.filter((b) => b.team === 'jackal').indexOf(bot);
      const [x, z] = points[Math.abs(idx) % points.length];
      return { x, z };
    },
    escortPoint(bot) {
      const carrier = bomb.carrier;
      const idx = bots.filter((b) => b.team === 'jackal').indexOf(bot);
      if (carrier && carrier !== bot) {
        const offsets = [[-3, 3], [3, 3], [0, 6]];
        const [ox, oz] = offsets[Math.abs(idx) % offsets.length];
        return { x: Math.max(-34, Math.min(34, carrier.position.x + ox)), z: Math.max(-22, Math.min(22, carrier.position.z + oz)) };
      }
      const site = world.sites[bot.assignedSite];
      return { x: site.x * 0.55, z: site.z + 9 };
    },
    holdPointFor(bot) {
      return bot.holdPoint ?? HOLD_POINTS[0];
    },
    nearestCarrierCandidate(bot) {
      let best = null;
      let bestDist = Infinity;
      for (const other of bots) {
        if (other.team !== 'jackal' || !other.alive) continue;
        const d = Math.hypot(other.position.x - bomb.groundPos.x, other.position.z - bomb.groundPos.z);
        if (d < bestDist) { bestDist = d; best = other; }
      }
      return best === bot;
    },
  };

  // --- Round setup ---------------------------------------------------------------------
  function botBuy(bot) {
    // (A bot that died last round already had its loadout cleared in startRound.)
    if (!bot.weapons.primary) {
      const marksman = bot.role === 'marksman';
      if (marksman && bot.money >= WEAPONS.longbow.price && match.round >= 3) botBuyWeapon(bot, 'longbow');
      else if (bot.money >= WEAPONS.carbine.price) botBuyWeapon(bot, 'carbine');
      else if (bot.money >= WEAPONS.scatter.price) botBuyWeapon(bot, 'scatter');
    }
    if (bot.armor <= 0 && bot.money >= ARMOR_PRICE + 300) {
      bot.money -= ARMOR_PRICE;
      bot.armor = 100;
    }
    if (bot.team === 'jackal' && bot.money >= GRENADE_DEFS.frag.price + 400 && bot.grenades.frag === 0 && rng() < 0.5) {
      bot.money -= GRENADE_DEFS.frag.price;
      bot.grenades.frag = 1;
    }
  }
  function botBuyWeapon(bot, id) {
    bot.money -= WEAPONS[id].price;
    bot.equip(id);
  }

  function startRound(first = false) {
    match.round += 1;
    match.difficulty = Math.min(1.35, 0.85 + match.round * 0.045);
    match.defuseProgress = 0;
    bomb.planted = false;
    bomb.state = 'carried';
    bomb.site = null;
    bombMesh.visible = false;
    for (const g of grenades) scene.remove(g.mesh);
    grenades.length = 0;
    noises.length = 0;

    const siteChoice = rng() < 0.5 ? 'A' : 'B';
    const wardenSpawns = world.spawns.warden;
    const jackalSpawns = world.spawns.jackal;
    playerCtrl.teleport(wardenSpawns[1][0] + 1.5, wardenSpawns[1][1], yawFor(0, 1));
    if (!playerActor.alive) {
      playerActor.weapons.primary = null;
      playerActor.current = 'secondary';
      playerActor.armor = 0;
    }
    playerActor.alive = true;
    playerActor.health = 100;
    playerActor.hasBomb = false;
    for (const weapon of Object.values(playerActor.weapons)) weapon?.refill();

    let wi = 0;
    let ji = 0;
    bots.forEach((bot) => {
      const wasAlive = bot.alive;
      if (bot.team === 'warden') {
        const [x, z] = wardenSpawns[[0, 2, 3][wi] ?? 0];
        bot.reset(x, z, yawFor(0, 1));
        bot.holdPoint = HOLD_POINTS[(wi + match.round) % HOLD_POINTS.length];
        wi += 1;
      } else {
        const [x, z] = jackalSpawns[ji % jackalSpawns.length];
        bot.reset(x, z, yawFor(0, -1));
        bot.assignedSite = siteChoice;
        ji += 1;
      }
      if (!wasAlive) {
        bot.weapons.primary = null;
        bot.current = 'secondary';
        bot.armor = 0;
        bot.grenades.frag = 0;
        bot.grenades.flash = 0;
      }
      for (const weapon of Object.values(bot.weapons)) weapon?.refill();
      botBuy(bot);
    });
    const planter = bots.find((b) => b.team === 'jackal' && b.role === 'planter') ?? bots.find((b) => b.team === 'jackal');
    planter.hasBomb = true;
    bomb.carrier = planter;

    match.phase = 'buy';
    match.phaseLeft = BUY_TIME;
    emit({ type: 'roundStart', round: match.round, score: { ...match.score }, first });
  }

  function endMatch() {
    match.phase = 'matchEnd';
    match.winner = match.score.warden === match.score.jackal ? 'draw' : match.score.warden > match.score.jackal ? 'warden' : 'jackal';
    emit({ type: 'matchEnd', winner: match.winner, score: { ...match.score } });
  }

  // --- Per-tick update ------------------------------------------------------------------
  function step(dt) {
    match.time += dt;
    // Effects always animate, whatever the phase.
    for (const t of tracers) {
      if (t.life > 0) {
        t.life -= dt;
        if (t.life <= 0) t.line.visible = false;
      }
    }
    for (const p of puffs) {
      if (p.life > 0) {
        p.life -= dt;
        p.mesh.position.addScaledVector(p.vel, dt);
        p.mesh.material.opacity = Math.max(0, p.life / p.max);
        p.mesh.scale.multiplyScalar(1 + dt * 3);
        if (p.life <= 0) p.mesh.visible = false;
      }
    }
    if (blast.life > 0) {
      blast.life -= dt;
      const frac = 1 - Math.max(0, blast.life) / 0.8;
      blastMesh.visible = true;
      blastMesh.scale.setScalar(1 + frac * blast.radius * 1.6);
      blastMesh.material.opacity = 0.55 * (1 - frac);
      blastLight.intensity *= Math.max(0, 1 - dt * 6);
      if (blast.life <= 0) blastMesh.visible = false;
    }
    for (const bot of bots) {
      if (bot.flashLeft > 0) {
        bot.flashLeft -= dt;
        bot.muzzleFlash.visible = bot.flashLeft > 0;
        bot.muzzleFlash.rotation.z = match.time * 31;
      }
    }
    stepGrenades(dt);

    if (match.phase === 'buy') {
      match.phaseLeft -= dt;
      for (const bot of bots) bot.step(0, botCtx); // settle death poses only
      if (match.phaseLeft <= 0) {
        match.phase = 'live';
        match.phaseLeft = ROUND_TIME;
        emit({ type: 'roundLive', round: match.round });
      }
      return;
    }
    if (match.phase === 'live' || match.phase === 'planted') {
      match.phaseLeft -= dt;
      for (const bot of bots) bot.step(dt, botCtx);
      for (const weapon of Object.values(playerActor.weapons)) weapon?.step(dt);
      // Ground bomb pickup by walking over it.
      if (bomb.state === 'ground') {
        for (const bot of bots) {
          if (bot.team === 'jackal' && bot.alive && Math.hypot(bot.position.x - bomb.groundPos.x, bot.position.z - bomb.groundPos.z) < 1.3) {
            bot.hasBomb = true;
            bomb.state = 'carried';
            bomb.carrier = bot;
            bombMesh.visible = false;
            emit({ type: 'notice', text: 'The Jackals recovered the Charge' });
            break;
          }
        }
      }
      if (bomb.planted) {
        bomb.timer -= dt;
        const interval = bomb.timer > 20 ? 1 : bomb.timer > 10 ? 0.5 : 0.25;
        if (match.time - match.lastBeepAt >= interval) {
          match.lastBeepAt = match.time;
          bombLightMesh.material.color.setHex(Math.floor(match.time * 4) % 2 ? 0xff4040 : 0x661111);
          if (Math.hypot(playerBody.position.x - bomb.position.x, playerBody.position.z - bomb.position.z) < 34) audio.beep(bomb.timer < 3);
        }
        if (bomb.timer <= 0) explodeBomb();
      } else if (match.phaseLeft <= 0) {
        endRound('warden', 'Time expired — the sites hold');
      }
      return;
    }
    if (match.phase === 'roundEnd') {
      match.phaseLeft -= dt;
      for (const bot of bots) bot.step(0, botCtx);
      if (match.phaseLeft <= 0) {
        if (match.score.warden >= WIN_ROUNDS || match.score.jackal >= WIN_ROUNDS || match.round >= MAX_ROUNDS) endMatch();
        else startRound();
      }
    }
  }

  // --- Player-facing API (called by main.js) ----------------------------------------------
  function currentWeapon(actor) {
    return actor.weapons[actor.current] ?? actor.weapons.secondary;
  }

  const api = {
    actors,
    player: playerActor,
    bomb,
    match,
    startMatch() {
      match.round = 0;
      match.score.warden = 0;
      match.score.jackal = 0;
      match.winner = null;
      for (const actor of actors) {
        actor.money = 800;
        actor.kills = 0;
        actor.deaths = 0;
        actor.alive = true;
        actor.weapons.primary = null;
        actor.current = 'secondary';
        actor.weapons.secondary.refill();
        actor.armor = 0;
        actor.grenades.frag = 0;
        actor.grenades.flash = 0;
      }
      startRound(true);
    },
    step,
    // Returns recoil to apply, or null when the gun could not fire.
    playerShoot(origin, dir, scoped) {
      if (!playerActor.alive || (match.phase !== 'live' && match.phase !== 'planted')) return null;
      const weapon = currentWeapon(playerActor);
      const def = weapon.state.def;
      if (!weapon.canFire()) {
        if (weapon.state.mag === 0 && weapon.state.reloadLeft === 0) {
          audio.dryFire();
          weapon.startReload();
        }
        return null;
      }
      const bloom = weapon.fire();
      const spread = spreadFor(def, playerCtrl.groundSpeed(), { crouching: playerBody.crouching, scoped, grounded: playerBody.onGround }) + bloom;
      fireHitscan(playerActor, origin, dir, spread);
      return { recoil: def.recoil, def };
    },
    playerReload() {
      const weapon = currentWeapon(playerActor);
      if (weapon.startReload()) audio.reload();
    },
    playerSwitch(slot) {
      if (slot === 'primary' && playerActor.weapons.primary) playerActor.current = 'primary';
      else if (slot === 'secondary') playerActor.current = 'secondary';
      else return false;
      audio.draw();
      return true;
    },
    playerThrow(kind, origin, dir) {
      if (!playerActor.alive || playerActor.grenades[kind] <= 0) return false;
      if (match.phase !== 'live' && match.phase !== 'planted') return false;
      playerActor.grenades[kind] -= 1;
      throwGrenade(playerActor, kind, origin, dir);
      return true;
    },
    // Holding the use key near the planted Charge defuses it. Returns progress 0..1.
    playerDefuse(dt, holding) {
      match.defusing = false;
      if (!holding || !playerActor.alive || !bomb.planted) {
        match.defuseProgress = 0;
        return 0;
      }
      const dist = Math.hypot(playerBody.position.x - bomb.position.x, playerBody.position.z - bomb.position.z);
      if (dist > 2.1) {
        match.defuseProgress = 0;
        return 0;
      }
      match.defusing = true;
      match.defuseProgress += dt / DEFUSE_TIME;
      if (match.defuseProgress >= 1) {
        match.defuseProgress = 0;
        tryDefuse(playerActor);
        return 1;
      }
      return match.defuseProgress;
    },
    playerBuy(itemId) {
      if (match.phase !== 'buy') return { ok: false, reason: 'Buy time is over' };
      const buyWeapon = (id) => {
        const def = WEAPONS[id];
        if (playerActor.money < def.price) return { ok: false, reason: 'Not enough money' };
        playerActor.money -= def.price;
        playerActor.weapons.primary = createWeaponState(def);
        playerActor.current = 'primary';
        audio.buy();
        return { ok: true };
      };
      if (itemId === 'carbine' || itemId === 'scatter' || itemId === 'longbow') return buyWeapon(itemId);
      if (itemId === 'armor') {
        if (playerActor.armor >= 100) return { ok: false, reason: 'Armor is full' };
        if (playerActor.money < ARMOR_PRICE) return { ok: false, reason: 'Not enough money' };
        playerActor.money -= ARMOR_PRICE;
        playerActor.armor = 100;
        audio.buy();
        return { ok: true };
      }
      if (itemId === 'frag' || itemId === 'flash') {
        const def = GRENADE_DEFS[itemId];
        if (playerActor.grenades[itemId] >= 1) return { ok: false, reason: 'Already carried' };
        if (playerActor.money < def.price) return { ok: false, reason: 'Not enough money' };
        playerActor.money -= def.price;
        playerActor.grenades[itemId] += 1;
        audio.buy();
        return { ok: true };
      }
      return { ok: false, reason: 'Unknown item' };
    },
    spectateActor() {
      return bots.find((b) => b.team === 'warden' && b.alive) ?? bots.find((b) => b.alive) ?? null;
    },
    // Running is loud: the bots' hearing reads the same noise list as gunfire.
    playerNoise() {
      noise(playerBody.position, 15);
    },
    getSnapshot() {
      const weapon = currentWeapon(playerActor);
      return {
        phase: match.phase,
        phaseLeft: Math.max(0, match.phaseLeft),
        round: match.round,
        score: { ...match.score },
        health: Math.max(0, Math.ceil(playerActor.health)),
        armor: Math.max(0, Math.ceil(playerActor.armor)),
        money: playerActor.money,
        alive: playerActor.alive,
        weaponName: weapon.state.def.name,
        weaponId: weapon.state.def.id,
        mag: weapon.state.mag,
        reserve: weapon.state.reserve,
        reloading: weapon.state.reloadLeft > 0,
        reloadFrac: weapon.state.reloadLeft > 0 ? 1 - weapon.state.reloadLeft / weapon.state.def.reloadTime : 0,
        hasPrimary: !!playerActor.weapons.primary,
        grenades: { ...playerActor.grenades },
        bombPlanted: bomb.planted,
        bombSite: bomb.site,
        bombTimer: bomb.planted ? Math.max(0, bomb.timer) : 0,
        bombNear: bomb.planted && Math.hypot(playerBody.position.x - bomb.position.x, playerBody.position.z - bomb.position.z) < 2.6,
        defuseProgress: match.defuseProgress,
        winner: match.winner,
        time: match.time,
      };
    },
    // Deterministic staging for screenshots: main.js arranges a scene, then
    // freezes the simulation. These helpers only move pieces; nothing here runs
    // during a real match.
    stage: {
      setPhase(phase, left) {
        match.phase = phase;
        match.phaseLeft = left;
      },
      plantAt(siteId, x, z) {
        bomb.planted = true;
        bomb.state = 'planted';
        bomb.site = siteId;
        bomb.position.set(x, 0, z);
        bomb.timer = 24;
        bombMesh.visible = true;
        bombMesh.position.set(x, 0.12, z);
        match.phase = 'planted';
        match.phaseLeft = 24;
      },
      botAt(name, x, z, yaw) {
        const bot = bots.find((b) => b.name === name);
        if (bot) bot.reset(x, z, yaw);
        return bot;
      },
      hurtPlayer(health) {
        playerActor.health = health;
      },
      givePlayer(weaponId) {
        if (weaponId) {
          playerActor.weapons.primary = createWeaponState(WEAPONS[weaponId]);
          playerActor.current = 'primary';
        }
        playerActor.armor = 100;
        playerActor.money = 2450;
        playerActor.grenades.frag = 1;
      },
    },
  };
  return api;
}
