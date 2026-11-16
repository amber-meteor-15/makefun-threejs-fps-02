// Weapon definitions and the first-person view models. The definitions are the
// single source of truth for gunplay: damage, cadence, magazine, spread and price,
// read alike by the player's guns and the bots'. Accuracy is a cone in radians that
// grows with the shooter's speed — standing still (or crouching) is how you land
// shots; running sprays. Damage falls off past each gun's falloffStart.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

export const WEAPONS = {
  sidearm: {
    id: 'sidearm', name: 'P9 Sidearm', slot: 'secondary', price: 0,
    damage: 26, headMult: 4, legMult: 0.7, fireGap: 0.16, auto: false,
    mag: 12, reserve: 60, reloadTime: 1.4, pellets: 1,
    spreadStill: 0.004, spreadMove: 0.03, recoil: 0.01,
    falloffStart: 16, falloffPer: 0.012, range: 90, zoom: 0, sound: 'sidearm',
  },
  carbine: {
    id: 'carbine', name: 'VK-7 Carbine', slot: 'primary', price: 2700,
    damage: 33, headMult: 4, legMult: 0.75, fireGap: 0.1, auto: true,
    mag: 30, reserve: 90, reloadTime: 2.2, pellets: 1,
    spreadStill: 0.0022, spreadMove: 0.034, recoil: 0.013,
    falloffStart: 22, falloffPer: 0.008, range: 110, zoom: 0, sound: 'carbine',
  },
  scatter: {
    id: 'scatter', name: 'Mule-12 Scattergun', slot: 'primary', price: 1100,
    damage: 11, headMult: 2, legMult: 0.8, fireGap: 0.85, auto: false,
    mag: 6, reserve: 24, reloadTime: 2.6, pellets: 8,
    spreadStill: 0.038, spreadMove: 0.052, recoil: 0.05,
    falloffStart: 6, falloffPer: 0.055, range: 42, zoom: 0, sound: 'scatter',
  },
  longbow: {
    id: 'longbow', name: 'LB-9 Longbow', slot: 'primary', price: 3100,
    damage: 70, headMult: 3, legMult: 0.8, fireGap: 0.36, auto: false,
    mag: 10, reserve: 40, reloadTime: 2.4, pellets: 1,
    spreadStill: 0.0006, spreadMove: 0.055, recoil: 0.03,
    falloffStart: 40, falloffPer: 0.004, range: 160, zoom: 2.6, sound: 'longbow',
  },
};

export const GRENADE_DEFS = {
  frag: { id: 'frag', name: 'Frag Grenade', price: 300, fuse: 1.7, radius: 5.5, maxDamage: 95 },
  flash: { id: 'flash', name: 'Flash Charge', price: 200, fuse: 1.4, radius: 15, maxBlind: 2.6 },
};
export const ARMOR_PRICE = 650;
export const MAX_MONEY = 9000;

// Damage multiplier for a hit at `distance` metres with this gun.
export function falloff(def, distance) {
  if (distance <= def.falloffStart) return 1;
  return Math.max(0.3, 1 - (distance - def.falloffStart) * def.falloffPer);
}

// The spread cone (radians) for a shooter moving at `speed` m/s. Crouching and
// scoping steady the gun; jumping is hopeless.
export function spreadFor(def, speed, { crouching = false, scoped = false, grounded = true } = {}) {
  let spread = def.spreadStill + Math.min(1, speed / 5.4) * def.spreadMove;
  if (crouching) spread *= 0.6;
  if (scoped) spread *= 0.35;
  if (!grounded) spread += 0.03;
  return spread;
}

// One held weapon's live state: magazine, reserve, cooldown, reload. Bots and the
// player share it, so a bot's burst discipline obeys the same numbers.
export function createWeaponState(def) {
  const state = {
    def,
    mag: def.mag,
    reserve: def.reserve,
    cooldown: 0,
    reloadLeft: 0,
    bloom: 0, // extra spread from firing in a hurry; decays when you pause
  };
  return {
    state,
    step(dt) {
      state.cooldown = Math.max(0, state.cooldown - dt);
      state.bloom = Math.max(0, state.bloom - dt * 0.09);
      if (state.reloadLeft > 0) {
        state.reloadLeft = Math.max(0, state.reloadLeft - dt);
        if (state.reloadLeft === 0) {
          const take = Math.min(def.mag - state.mag, state.reserve);
          state.mag += take;
          state.reserve -= take;
        }
      }
    },
    canFire() {
      return state.mag > 0 && state.cooldown === 0 && state.reloadLeft === 0;
    },
    // Consumes a round and returns the bloom to add to this shot's spread.
    fire() {
      state.mag -= 1;
      state.cooldown = def.fireGap;
      const bloom = state.bloom;
      state.bloom = Math.min(0.045, state.bloom + (def.auto ? 0.006 : 0.002));
      return bloom;
    },
    startReload() {
      if (state.reloadLeft > 0 || state.mag === def.mag || state.reserve === 0) return false;
      state.reloadLeft = def.reloadTime;
      return true;
    },
    refill() {
      state.mag = def.mag;
      state.reserve = def.reserve;
      state.cooldown = 0;
      state.reloadLeft = 0;
      state.bloom = 0;
    },
  };
}

// --- View models -------------------------------------------------------------
// Four box-built guns with distinct silhouettes, a shared muzzle flash and light,
// view bob from the player's step cycle, recoil kick, a reload tilt and a draw
// raise. The held grenade is a small sphere with a pin ring.
export function createViewWeapon(camera) {
  const steel = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.steel), roughness: 0.42, metalness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.hairline), roughness: 0.7, metalness: 0.25 });
  const accentMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.accent), roughness: 0.5, metalness: 0.2, emissive: new THREE.Color(PALETTE.accent), emissiveIntensity: 0.35 });

  function part(parent, w, h, d, x, y, z, mat = steel) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  }

  function buildSidearm() {
    const g = new THREE.Group();
    part(g, 0.07, 0.11, 0.24, 0, 0, -0.1);
    part(g, 0.05, 0.05, 0.1, 0, -0.07, 0.02, dark);
    part(g, 0.02, 0.03, 0.02, 0, 0.07, -0.2, accentMat);
    return g;
  }
  function buildCarbine() {
    const g = new THREE.Group();
    part(g, 0.09, 0.11, 0.46, 0, 0, -0.12);
    part(g, 0.045, 0.045, 0.42, 0, 0.03, -0.5, dark);
    part(g, 0.07, 0.16, 0.09, 0, -0.12, -0.05, dark); // magazine
    part(g, 0.075, 0.09, 0.24, 0, -0.03, 0.24, dark); // stock
    part(g, 0.03, 0.05, 0.16, 0, 0.09, -0.18, dark); // carry sight
    part(g, 0.095, 0.02, 0.2, 0, -0.045, -0.2, accentMat); // stripe
    return g;
  }
  function buildScatter() {
    const g = new THREE.Group();
    part(g, 0.1, 0.12, 0.4, 0, 0, -0.08);
    part(g, 0.07, 0.07, 0.5, 0, 0.02, -0.48, dark);
    part(g, 0.085, 0.06, 0.2, 0, -0.06, -0.34, dark); // pump
    part(g, 0.08, 0.1, 0.22, 0, -0.02, 0.22, dark);
    return g;
  }
  function buildLongbow() {
    const g = new THREE.Group();
    part(g, 0.08, 0.1, 0.6, 0, 0, -0.2);
    part(g, 0.04, 0.04, 0.55, 0, 0.03, -0.72, dark);
    const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.2, 12), dark);
    scope.rotation.x = Math.PI / 2;
    scope.position.set(0, 0.1, -0.25);
    g.add(scope);
    part(g, 0.06, 0.14, 0.08, 0, -0.11, -0.02, dark);
    part(g, 0.07, 0.08, 0.26, 0, -0.02, 0.3, dark);
    part(g, 0.085, 0.02, 0.24, 0, 0.045, -0.3, accentMat);
    return g;
  }
  function buildGrenade() {
    const g = new THREE.Group();
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.055, 14, 10), dark);
    ball.position.set(0, -0.02, -0.1);
    g.add(ball);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.006, 8, 18), steel);
    ring.position.set(0.03, 0.045, -0.1);
    g.add(ring);
    return g;
  }

  const models = {
    sidearm: buildSidearm(),
    carbine: buildCarbine(),
    scatter: buildScatter(),
    longbow: buildLongbow(),
    grenade: buildGrenade(),
  };
  const holder = new THREE.Group();
  holder.position.set(0.25, -0.22, -0.45);
  camera.add(holder);
  for (const model of Object.values(models)) {
    model.visible = false;
    holder.add(model);
  }

  // The muzzle flash sprite: a radial glow with four spikes, painted on a canvas
  // at runtime — no image asset ships with the game.
  const flashCanvas = document.createElement('canvas');
  flashCanvas.width = 128;
  flashCanvas.height = 128;
  const fx = flashCanvas.getContext('2d');
  const glow = fx.createRadialGradient(64, 64, 2, 64, 64, 62);
  glow.addColorStop(0, 'rgba(255,244,205,1)');
  glow.addColorStop(0.35, 'rgba(255,176,74,0.85)');
  glow.addColorStop(1, 'rgba(255,120,40,0)');
  fx.fillStyle = glow;
  fx.fillRect(0, 0, 128, 128);
  fx.fillStyle = 'rgba(255,214,140,0.75)';
  for (let spike = 0; spike < 4; spike += 1) {
    fx.save();
    fx.translate(64, 64);
    fx.rotate((spike * Math.PI) / 2);
    fx.beginPath();
    fx.moveTo(0, -62);
    fx.lineTo(6, 0);
    fx.lineTo(-6, 0);
    fx.closePath();
    fx.fill();
    fx.restore();
  }
  const flash = new THREE.Mesh(
    new THREE.PlaneGeometry(0.34, 0.34),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(flashCanvas), transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
  );
  flash.position.set(0.25, -0.19, -0.98);
  flash.visible = false;
  camera.add(flash);
  const flashLight = new THREE.PointLight(new THREE.Color(PALETTE.accent), 0, 6);
  flashLight.position.set(0.25, -0.16, -0.7);
  camera.add(flashLight);

  const view = {
    current: 'sidearm',
    kick: 0,
    flashLeft: 0,
    drawLeft: 0,
    reloadFrac: 0, // 0..1 while reloading, set by main each frame
    scoped: false,
    hidden: false, // spectating: no view model at all
    setHidden(value) {
      view.hidden = value;
    },
    setWeapon(id) {
      if (view.current === id) return;
      view.current = id;
      view.drawLeft = 0.28;
      const showKey = id === 'frag' || id === 'flash' ? 'grenade' : id;
      for (const [key, model] of Object.entries(models)) model.visible = key === showKey;
    },
    onShoot() {
      view.flashLeft = 0.055;
      view.kick = Math.min(0.09, view.kick + 0.05);
    },
    update(dt, stepCycle, speed, time) {
      view.kick += (0 - view.kick) * Math.min(1, dt * 13);
      view.flashLeft = Math.max(0, view.flashLeft - dt);
      view.drawLeft = Math.max(0, view.drawLeft - dt);
      const bob = Math.sin(stepCycle * 2) * 0.012 * Math.min(1, speed / 3);
      const sway = Math.cos(stepCycle) * 0.008 * Math.min(1, speed / 3);
      const drawDip = view.drawLeft > 0 ? Math.sin((view.drawLeft / 0.28) * Math.PI) * 0.16 : 0;
      const reloadDip = view.reloadFrac > 0 ? Math.sin(Math.min(1, view.reloadFrac) * Math.PI) * 0.22 : 0;
      holder.position.set(0.25 + sway, -0.22 + bob - drawDip - reloadDip * 0.4, -0.45 + view.kick);
      holder.rotation.x = view.kick * 2.4 - drawDip * 1.4 - reloadDip;
      holder.rotation.z = sway * 1.4;
      holder.visible = !view.scoped && !view.hidden;
      flash.visible = view.flashLeft > 0 && !view.scoped;
      flash.rotation.z = time * 37;
      flashLight.intensity = view.flashLeft > 0 ? 16 : 0;
    },
  };
  models.sidearm.visible = true;
  return view;
}
