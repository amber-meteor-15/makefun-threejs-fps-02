// Boot and the one loop: a fixed 60 Hz simulation (player body + match) feeding a
// render at the display's rate. This module is the wiring: input routes to the
// player and the match, match events route to the HUD and the audio, and the
// camera follows the player's eye — or a surviving teammate's, once you are down.
// ?shot=start|play|end with &seed=N stages a deterministic frame for a capture,
// renders it twice, then freezes it and sets window.__shotReady.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { createWorld } from './world.js';
import { createInput } from './input.js';
import { createPlayer } from './player.js';
import { createAudio } from './audio.js';
import { WEAPONS, GRENADE_DEFS, spreadFor, createViewWeapon } from './weapons.js';
import { createMatch } from './match.js';
import { createHud } from './hud.js';

const FIXED_STEP = 1 / 60;
const BASE_FOV = 74;
const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');
const seed = Number.parseInt(params.get('seed') ?? '1', 10) || 1;

function mulberry32(initial) {
  let a = initial;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(seed * 7919 + 13);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.18;
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.canvas);
scene.fog = new THREE.Fog(new THREE.Color(PALETTE.canvas), 42, 125);
const camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.05, 220);
scene.add(camera);

const audio = createAudio();
const world = createWorld(scene);
const playerCtrl = createPlayer(world.colliders);
const body = playerCtrl.state;
const viewWeapon = createViewWeapon(camera);

let started = false;
let overlayMode = 'start'; // start | paused | matchEnd | null
let selection = { kind: 'gun' };
let lastGunSlot = 'secondary';
let prevFiring = false;
let lastStepCycle = 0;
let radarAt = 0;

const hud = createHud({
  onPlay: () => {
    if (shot) return;
    audio.unlock();
    if (overlayMode === 'start') {
      started = true;
      overlayMode = null;
      hud.hideOverlay();
      hud.showBuy(match.getSnapshot());
    } else if (overlayMode === 'matchEnd') {
      overlayMode = null;
      hud.hideOverlay();
      match.startMatch(); // its roundStart event opens the buy menu
    } else {
      overlayMode = null;
      hud.hideOverlay();
      input.requestLock();
    }
  },
  onBuy: (itemId) => {
    const result = match.playerBuy(itemId);
    hud.buyResult(result);
    hud.update(mergedSnapshot(), 10);
  },
  onDeploy: () => {
    hud.hideBuy();
    input.requestLock();
  },
});

function emit(evt) {
  switch (evt.type) {
    case 'killfeed':
      hud.killfeed(evt);
      break;
    case 'hitConfirm':
      hud.hitMarker(evt.killed, shot ? 4000 : 110);
      audio.hit(evt.killed);
      if (evt.headshot) audio.headshotDing();
      break;
    case 'playerHurt': {
      const dx = evt.fromPos.x - body.position.x;
      const dz = evt.fromPos.z - body.position.z;
      const fx = -Math.sin(body.yaw);
      const fz = -Math.cos(body.yaw);
      const rx = Math.cos(body.yaw);
      const rz = -Math.sin(body.yaw);
      hud.damageFrom(Math.atan2(dx * rx + dz * rz, dx * fx + dz * fz));
      break;
    }
    case 'playerFlashed':
      hud.flash(evt.strength, evt.duration);
      break;
    case 'playerDeath':
      hud.notice(`Down — ${evt.killer} got you. Spectating your team.`);
      break;
    case 'planted':
      hud.banner('THE CHARGE IS PLANTED', `Site ${evt.site} — defuse it, or hold the line`);
      break;
    case 'defused':
      hud.banner('CHARGE DEFUSED', `${evt.by} saved the foundry`);
      break;
    case 'roundEnd': {
      const won = evt.winner === 'warden';
      const reasonText = evt.reason === 'elimination'
        ? (won ? 'Enemy team eliminated' : 'Your team was eliminated')
        : evt.reason;
      hud.banner(won ? 'ROUND WON' : 'ROUND LOST', `${reasonText} · Wardens ${evt.score.warden} — ${evt.score.jackal} Jackals`, 3400);
      break;
    }
    case 'roundStart':
      hud.setSpectating(null);
      viewWeapon.setHidden(false);
      selection = { kind: 'gun' };
      if (started && !shot) {
        hud.showBuy(match.getSnapshot());
        if (document.pointerLockElement) document.exitPointerLock();
      }
      break;
    case 'roundLive':
      hud.notice(`Round ${evt.round} — live`);
      break;
    case 'channel':
      hud.notice(evt.kind === 'plant' ? `${evt.who} is planting the Charge!` : `${evt.who} is defusing the Charge!`);
      break;
    case 'notice':
      hud.notice(evt.text);
      break;
    case 'matchEnd': {
      overlayMode = 'matchEnd';
      const title = evt.winner === 'warden' ? 'VICTORY' : evt.winner === 'draw' ? 'DRAW' : 'DEFEAT';
      hud.showOverlay('matchEnd', { title, copy: `Final score — Wardens ${evt.score.warden}, Jackals ${evt.score.jackal}.` });
      if (document.pointerLockElement) document.exitPointerLock();
      break;
    }
    default:
      break;
  }
}

const match = createMatch({ scene, world, audio, playerCtrl, emit, rng });
const input = createInput(renderer.domElement, onLockChange);

// If a pointer-lock request was refused (browsers throttle re-locks), a click on
// the canvas is the way back in.
renderer.domElement.addEventListener('click', () => {
  if (started && !input.state.locked && !hud.buyOpen() && overlayMode === null && !shot) input.requestLock();
});

function onLockChange(locked) {
  if (shot) return;
  if (locked) {
    overlayMode = null;
    hud.hideOverlay();
    hud.hideBuy();
    return;
  }
  if (!started) {
    overlayMode = 'start';
    hud.showOverlay('start');
    return;
  }
  const phase = match.match.phase;
  if (phase === 'buy' || phase === 'matchEnd' || overlayMode === 'matchEnd') return;
  if (hud.buyOpen()) return;
  overlayMode = 'paused';
  hud.showOverlay('paused');
}

function mergedSnapshot() {
  const snap = match.getSnapshot();
  if (selection.kind === 'grenade') {
    snap.selectionKind = 'grenade';
    snap.selectionName = GRENADE_DEFS[selection.grenade].name;
  } else {
    snap.selectionKind = 'gun';
    snap.selectionName = snap.weaponName;
  }
  return snap;
}

function selectSlot(code) {
  const snap = match.getSnapshot();
  if (code === 'Digit1' && snap.hasPrimary) {
    selection = { kind: 'gun' };
    lastGunSlot = 'primary';
    match.playerSwitch('primary');
    viewWeapon.setWeapon(match.getSnapshot().weaponId);
  } else if (code === 'Digit2') {
    selection = { kind: 'gun' };
    lastGunSlot = 'secondary';
    match.playerSwitch('secondary');
    viewWeapon.setWeapon('sidearm');
  } else if (code === 'Digit3' && snap.grenades.frag > 0) {
    selection = { kind: 'grenade', grenade: 'frag' };
    viewWeapon.setWeapon('frag');
    audio.draw();
  } else if (code === 'Digit4' && snap.grenades.flash > 0) {
    selection = { kind: 'grenade', grenade: 'flash' };
    viewWeapon.setWeapon('flash');
    audio.draw();
  }
}

function handlePressed() {
  for (const code of input.takePressed()) {
    if (hud.buyOpen()) {
      const buyOrder = ['carbine', 'scatter', 'longbow', 'armor', 'frag', 'flash'];
      if (code.startsWith('Digit')) {
        const idx = Number(code.slice(5)) - 1;
        if (buyOrder[idx]) hud.buyResult(match.playerBuy(buyOrder[idx]));
      }
      if (code === 'Enter' || code === 'KeyB') {
        hud.hideBuy();
        input.requestLock();
      }
      continue;
    }
    if (!input.state.locked) continue;
    if (code === 'Digit1' || code === 'Digit2' || code === 'Digit3' || code === 'Digit4') selectSlot(code);
    else if (code === 'KeyR' && selection.kind === 'gun') match.playerReload();
    else if (code === 'KeyB' && match.match.phase === 'buy') {
      hud.showBuy(match.getSnapshot());
      document.exitPointerLock();
    }
  }
}

const camDir = new THREE.Vector3();
function tryFire() {
  const snap = match.getSnapshot();
  const phase = match.match.phase;
  if (phase !== 'live' && phase !== 'planted') return;
  camera.getWorldDirection(camDir);
  if (selection.kind === 'grenade') {
    if (!prevFiring && input.state.firing) {
      const origin = camera.position.clone().addScaledVector(camDir, 0.4);
      if (match.playerThrow(selection.grenade, origin, camDir.clone())) {
        selection = { kind: 'gun' };
        viewWeapon.setWeapon(match.getSnapshot().weaponId);
      }
    }
    return;
  }
  const def = WEAPONS[snap.weaponId];
  if (!def) return;
  if (!input.state.firing) return;
  if (!def.auto && prevFiring) return;
  const scoped = input.state.aiming && def.id === 'longbow';
  const result = match.playerShoot(camera.position, camDir.clone(), scoped || input.state.aiming);
  if (result) {
    viewWeapon.onShoot();
    playerCtrl.recoil(result.recoil * (scoped ? 0.45 : 1), (rng() * 2 - 1) * result.recoil * 0.4);
  }
}

function simulate(dt) {
  const phase = match.match.phase;
  const alive = match.player.alive;
  if (alive && (phase === 'live' || phase === 'planted' || phase === 'roundEnd')) {
    playerCtrl.step(dt, input.state.keys);
    // Footsteps: one per half step-cycle; running is audible to the bots.
    if (body.onGround && Math.floor(body.stepCycle / Math.PI) !== Math.floor(lastStepCycle / Math.PI)) {
      const speed = playerCtrl.groundSpeed();
      if (speed > 0.6) {
        audio.footstep(speed > 4);
        if (speed > 4.2) match.playerNoise();
      }
    }
    lastStepCycle = body.stepCycle;
  }
  match.step(dt);
  if (alive) match.playerDefuse(dt, input.state.keys.has('KeyF'));
}

function syncCamera() {
  const snap = match.getSnapshot();
  if (!snap.alive) {
    const target = match.spectateActor();
    viewWeapon.setHidden(true);
    if (target) {
      camera.position.set(target.position.x, target.position.y + 1.58, target.position.z);
      camera.rotation.set(-0.04, target.yaw, 0, 'YXZ');
      hud.setSpectating(target.name);
    }
    return;
  }
  const speed = playerCtrl.groundSpeed();
  const bobY = body.onGround ? Math.sin(body.stepCycle * 2) * 0.026 * Math.min(1, speed / 3) : 0;
  camera.position.set(body.position.x, body.position.y + body.eye + bobY, body.position.z);
  const rightX = Math.cos(body.yaw);
  const rightZ = -Math.sin(body.yaw);
  const lateral = body.velocity.x * rightX + body.velocity.z * rightZ;
  camera.rotation.set(body.pitch, body.yaw, THREE.MathUtils.clamp(-lateral * 0.007, -0.03, 0.03), 'YXZ');
  // Aim zoom: a gentle steady for any gun, the longbow's scope for its own.
  const def = WEAPONS[snap.weaponId];
  const aiming = input.state.aiming && selection.kind === 'gun';
  const scoped = aiming && def && def.id === 'longbow';
  const targetFov = scoped ? BASE_FOV / def.zoom : aiming ? 66 : BASE_FOV;
  if (Math.abs(camera.fov - targetFov) > 0.05) {
    camera.fov += (targetFov - camera.fov) * 0.35;
    camera.updateProjectionMatrix();
  }
  viewWeapon.scoped = !!scoped;
  hud.setScoped(!!scoped);
}

let accumulator = 0;
let lastTime = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;
  const elapsed = now / 1000;

  if (started) {
    const snap0 = match.getSnapshot();
    const sens = viewWeapon.scoped ? 0.38 : input.state.aiming ? 0.75 : 1;
    if (input.state.locked && snap0.alive) {
      const look = input.takeLook();
      playerCtrl.look(look.x * sens, look.y * sens);
    } else {
      input.takeLook();
    }
    handlePressed();
    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED_STEP && steps < 5) {
      simulate(FIXED_STEP);
      accumulator -= FIXED_STEP;
      steps += 1;
    }
    if (accumulator > FIXED_STEP * 5) accumulator = 0;
  }

  syncCamera();
  if (started) {
    tryFire();
    prevFiring = input.state.firing;
  }
  const snap = mergedSnapshot();
  viewWeapon.reloadFrac = snap.reloadFrac;
  if (selection.kind === 'gun' && viewWeapon.current !== snap.weaponId) viewWeapon.setWeapon(snap.weaponId);
  viewWeapon.update(dt, body.stepCycle, playerCtrl.groundSpeed(), elapsed);
  world.update(dt, elapsed);

  const def = WEAPONS[snap.weaponId];
  let gap = 9;
  if (selection.kind === 'gun' && def) {
    const spread = spreadFor(def, playerCtrl.groundSpeed(), { crouching: body.crouching, scoped: input.state.aiming, grounded: body.onGround });
    gap = 5 + (spread * (window.innerHeight / 2)) / Math.tan((camera.fov * Math.PI) / 360);
  }
  hud.update(snap, gap);
  if (input.state.keys.has('Tab')) hud.showScoreboard(match.actors, match.match.score);
  else hud.hideScoreboard();
  if (elapsed - radarAt > 0.15) {
    radarAt = elapsed;
    const bomb = match.bomb;
    const bombView = bomb.planted
      ? { visible: true, x: bomb.position.x, z: bomb.position.z }
      : bomb.state === 'ground'
        ? { visible: true, x: bomb.groundPos.x, z: bomb.groundPos.z }
        : { visible: false, x: 0, z: 0 };
    hud.drawRadar(match.actors, { x: body.position.x, z: body.position.z, yaw: body.yaw }, world.sites, bombView);
  }
  renderer.render(scene, camera);
}

// --- Screenshot staging ---------------------------------------------------------
function stageShot(name) {
  match.startMatch();
  hud.hideOverlay();
  overlayMode = null;
  const stage = match.stage;
  if (name === 'start') {
    stage.setPhase('live', 95);
    stage.botAt('Vex', -3.5, -12, Math.PI);
    stage.botAt('Ondo', 4, -10.5, Math.PI + 0.2);
    stage.botAt('Pell', 9, -14, Math.PI - 0.3);
    stage.botAt('Sable', 0, 10, 0);
    stage.botAt('Rurik', -24, 5, -Math.PI / 2);
    playerCtrl.teleport(0, -17.5, Math.PI);
    body.pitch = -0.03;
  } else if (name === 'play') {
    stage.givePlayer('carbine');
    stage.setPhase('live', 64);
    stage.hurtPlayer(72);
    stage.botAt('Rurik', 1.2, -2.2, Math.PI / 2);
    const ondo = stage.botAt('Ondo', -8.5, 1.5, -Math.PI / 2);
    if (ondo) ondo.crouching = true;
    stage.botAt('Sable', 14, 6, Math.PI);
    playerCtrl.teleport(-6.2, -2, -Math.PI / 2);
    body.pitch = -0.01;
    match.step(FIXED_STEP);
    match.step(FIXED_STEP);
    syncCamera();
    camera.getWorldDirection(camDir);
    match.playerShoot(camera.position, camDir.clone(), false);
    viewWeapon.onShoot();
  } else {
    stage.givePlayer('carbine');
    stage.hurtPlayer(58);
    stage.plantAt('B', 26, -15);
    match.match.defuseProgress = 0.62;
    const rurik = stage.botAt('Rurik', 28.5, -12.5, 0);
    if (rurik) {
      rurik.alive = false;
      rurik.fall = 1; // match.step(0) below poses the body with its death fall
    }
    stage.botAt('Kitt', 31, -19.5, 2.33);
    stage.botAt('Vex', 20, -9, -2.2);
    playerCtrl.teleport(24.3, -12.6, -0.615);
    body.crouching = true;
    body.eye = 1.04;
    body.pitch = -0.28;
  }
  match.step(0);
  syncCamera();
  viewWeapon.update(0.004, body.stepCycle, 0, 1);
  hud.update(mergedSnapshot(), 9);
  const bombNow = match.bomb;
  hud.drawRadar(match.actors, { x: body.position.x, z: body.position.z, yaw: body.yaw }, world.sites,
    bombNow.planted ? { visible: true, x: bombNow.position.x, z: bombNow.position.z } : { visible: false, x: 0, z: 0 });
  let painted = 0;
  function paint() {
    requestAnimationFrame(paint);
    syncCamera();
    renderer.render(scene, camera);
    painted += 1;
    if (painted === 2) window.__shotReady = true;
  }
  requestAnimationFrame(paint);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

if (shot) stageShot(shot);
else {
  match.startMatch();
  syncCamera();
  requestAnimationFrame(frame);
}
