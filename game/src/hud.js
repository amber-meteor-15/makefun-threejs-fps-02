// The DOM HUD: crosshair, hit marker, health and armor, money, ammunition, the
// round clock and score, killfeed, banners, damage feedback, a radar, the buy
// menu, the scoreboard and the overlays. It never touches the simulation;
// main.js pushes snapshots and events in, and reads the menu callbacks out.
import { WEAPONS, GRENADE_DEFS, ARMOR_PRICE } from './weapons.js';

const BUY_ITEMS = [
  { id: 'carbine', label: WEAPONS.carbine.name, detail: 'Automatic rifle', price: WEAPONS.carbine.price, key: '1' },
  { id: 'scatter', label: WEAPONS.scatter.name, detail: 'Pump scattergun', price: WEAPONS.scatter.price, key: '2' },
  { id: 'longbow', label: WEAPONS.longbow.name, detail: 'Scoped marksman rifle', price: WEAPONS.longbow.price, key: '3' },
  { id: 'armor', label: 'Kevlar Vest', detail: 'Absorbs half of all damage', price: ARMOR_PRICE, key: '4' },
  { id: 'frag', label: GRENADE_DEFS.frag.name, detail: 'High explosive', price: GRENADE_DEFS.frag.price, key: '5' },
  { id: 'flash', label: GRENADE_DEFS.flash.name, detail: 'Blinds anyone looking', price: GRENADE_DEFS.flash.price, key: '6' },
];

function el(id) {
  return document.getElementById(id);
}
function fmtTime(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function createHud({ onPlay, onBuy, onDeploy }) {
  const crosshair = el('crosshair');
  const hitmarker = el('hitmarker');
  const healthNum = el('health-num');
  const healthFill = el('health-fill');
  const armorFill = el('armor-fill');
  const armorNum = el('armor-num');
  const money = el('money');
  const ammoMag = el('ammo-mag');
  const ammoReserve = el('ammo-reserve');
  const ammoBox = el('ammo');
  const weaponName = el('weapon-name');
  const grenades = el('grenades');
  const timer = el('timer');
  const phaseLabel = el('phase-label');
  const scoreW = el('score-warden');
  const scoreJ = el('score-jackal');
  const killfeed = el('killfeed');
  const banner = el('banner');
  const bannerTitle = el('banner-title');
  const bannerSub = el('banner-sub');
  const notice = el('notice');
  const vignette = el('damage-vignette');
  const damageDir = el('damage-dir');
  const flashOverlay = el('flash-overlay');
  const defuseWrap = el('defuse-wrap');
  const defuseFill = el('defuse-fill');
  const interactPrompt = el('interact-prompt');
  const buyMenu = el('buy-menu');
  const buyItems = el('buy-items');
  const buyMoney = el('buy-money');
  const buyMsg = el('buy-msg');
  const buyTimer = el('buy-timer');
  const scoreboard = el('scoreboard');
  const scoreboardBody = el('scoreboard-body');
  const scopeOverlay = el('scope-overlay');
  const spectateLabel = el('spectate-label');
  const overlay = el('overlay');
  const overlayTitle = el('overlay-title');
  const overlayCopy = el('overlay-copy');
  const playButton = el('play');
  const radar = el('radar');
  const radarCtx = radar.getContext('2d');

  let hitTimer = 0;
  let bannerTimer = 0;
  let noticeTimer = 0;
  let vignetteUntil = 0;
  const last = {};

  function setText(node, key, value) {
    if (last[key] === value) return;
    last[key] = value;
    node.textContent = value;
  }

  // Buy menu buttons are built once; refreshBuy only toggles their state.
  const buyButtons = new Map();
  for (const item of BUY_ITEMS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'buy-item';
    button.innerHTML = `<span class="buy-key">${item.key}</span><span class="buy-main"><b>${item.label}</b><small>${item.detail}</small></span><span class="buy-price">$${item.price}</span>`;
    button.addEventListener('click', () => onBuy(item.id));
    buyItems.appendChild(button);
    buyButtons.set(item.id, button);
  }
  el('deploy').addEventListener('click', () => onDeploy());
  playButton.addEventListener('click', () => onPlay());

  function refreshBuy(snapshot) {
    buyMoney.textContent = `$${snapshot.money}`;
    buyTimer.textContent = `Buy time ${fmtTime(snapshot.phaseLeft)}`;
    for (const item of BUY_ITEMS) {
      const button = buyButtons.get(item.id);
      let owned = false;
      if (item.id === 'armor') owned = snapshot.armor >= 100;
      else if (item.id === 'frag' || item.id === 'flash') owned = snapshot.grenades[item.id] >= 1;
      else owned = snapshot.weaponId === item.id;
      button.disabled = snapshot.money < item.price || owned;
      button.classList.toggle('owned', owned);
    }
  }

  return {
    update(snapshot, crosshairGapPx) {
      setText(healthNum, 'hp', String(snapshot.health));
      healthFill.style.width = `${snapshot.health}%`;
      healthFill.style.background = snapshot.health <= 30 ? 'var(--danger)' : 'var(--warden)';
      armorFill.style.width = `${snapshot.armor}%`;
      setText(armorNum, 'armor', snapshot.armor > 0 ? String(snapshot.armor) : '');
      setText(money, 'money', `$${snapshot.money}`);
      setText(weaponName, 'wname', snapshot.selectionName ?? snapshot.weaponName);
      if (snapshot.selectionKind === 'grenade') {
        setText(ammoMag, 'mag', '✸');
        setText(ammoReserve, 'res', 'click to throw');
        ammoBox.classList.remove('empty');
      } else {
        setText(ammoMag, 'mag', String(snapshot.mag));
        setText(ammoReserve, 'res', snapshot.reloading ? 'RELOADING' : `/ ${snapshot.reserve}`);
        ammoBox.classList.toggle('empty', snapshot.mag === 0 && !snapshot.reloading);
      }
      setText(grenades, 'nades', `Frag ${snapshot.grenades.frag ? '●' : '○'} · Flash ${snapshot.grenades.flash ? '●' : '○'}`);
      const clock = snapshot.bombPlanted ? snapshot.bombTimer : snapshot.phaseLeft;
      setText(timer, 'timer', fmtTime(clock));
      timer.classList.toggle('urgent', snapshot.bombPlanted || (snapshot.phase === 'live' && snapshot.phaseLeft <= 10));
      const phaseText = snapshot.phase === 'buy' ? `ROUND ${snapshot.round} · BUY PHASE`
        : snapshot.phase === 'planted' ? `CHARGE PLANTED · SITE ${snapshot.bombSite}`
          : snapshot.phase === 'roundEnd' ? `ROUND ${snapshot.round} · OVER`
            : snapshot.phase === 'matchEnd' ? 'MATCH OVER'
              : `ROUND ${snapshot.round} · FIRST TO 9`;
      setText(phaseLabel, 'phase', phaseText);
      setText(scoreW, 'sw', String(snapshot.score.warden));
      setText(scoreJ, 'sj', String(snapshot.score.jackal));
      crosshair.style.setProperty('--gap', `${Math.round(crosshairGapPx)}px`);
      if (!snapshot.alive) crosshair.style.opacity = '0';
      else if (crosshair.style.opacity === '0' && scopeOverlay.hidden) crosshair.style.opacity = '';
      // Defuse progress and prompt.
      if (snapshot.defuseProgress > 0) {
        defuseWrap.hidden = false;
        defuseFill.style.width = `${Math.round(snapshot.defuseProgress * 100)}%`;
      } else {
        defuseWrap.hidden = true;
      }
      interactPrompt.hidden = !(snapshot.bombNear && snapshot.alive && snapshot.defuseProgress === 0);
      // Damage vignette fades out after the hit.
      vignette.style.opacity = performance.now() < vignetteUntil ? '1' : '0';
      if (!buyMenu.hidden && snapshot.phase === 'buy') refreshBuy(snapshot);
      if (!buyMenu.hidden && snapshot.phase !== 'buy') buyMenu.hidden = true;
    },
    hitMarker(killed, holdMs = 110) {
      hitmarker.classList.add('on');
      hitmarker.classList.toggle('kill', killed);
      clearTimeout(hitTimer);
      hitTimer = setTimeout(() => hitmarker.classList.remove('on', 'kill'), holdMs);
    },
    damageFrom(relativeAngle) {
      vignetteUntil = performance.now() + 420;
      damageDir.style.transform = `translate(-50%, -50%) rotate(${relativeAngle}rad)`;
      damageDir.classList.add('on');
      setTimeout(() => damageDir.classList.remove('on'), 500);
    },
    flash(strength, durationSec) {
      flashOverlay.style.transition = 'none';
      flashOverlay.style.opacity = String(Math.min(1, strength));
      requestAnimationFrame(() => {
        flashOverlay.style.transition = `opacity ${Math.max(0.4, durationSec)}s linear`;
        flashOverlay.style.opacity = '0';
      });
    },
    killfeed({ killer, killerTeam, victim, victimTeam, weapon, headshot }) {
      const row = document.createElement('div');
      row.className = 'feed-row';
      row.innerHTML = `<b class="${killerTeam ?? ''}">${killer}</b><span class="feed-weapon">${weapon}${headshot ? ' ⌖' : ''}</span><b class="${victimTeam ?? ''}">${victim}</b>`;
      killfeed.appendChild(row);
      while (killfeed.children.length > 5) killfeed.firstChild.remove();
      setTimeout(() => row.classList.add('fade'), 3600);
      setTimeout(() => row.remove(), 4300);
    },
    banner(title, sub = '', holdMs = 2600) {
      bannerTitle.textContent = title;
      bannerSub.textContent = sub;
      banner.classList.add('on');
      clearTimeout(bannerTimer);
      bannerTimer = setTimeout(() => banner.classList.remove('on'), holdMs);
    },
    notice(text, holdMs = 2400) {
      notice.textContent = text;
      notice.classList.add('on');
      clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => notice.classList.remove('on'), holdMs);
    },
    showBuy(snapshot) {
      buyMenu.hidden = false;
      buyMsg.textContent = '';
      refreshBuy(snapshot);
    },
    hideBuy() {
      buyMenu.hidden = true;
    },
    buyResult(result) {
      buyMsg.textContent = result.ok ? 'Purchased' : result.reason;
      buyMsg.classList.toggle('error', !result.ok);
    },
    buyOpen() {
      return !buyMenu.hidden;
    },
    setScoped(on) {
      scopeOverlay.hidden = !on;
      crosshair.style.opacity = on ? '0' : '';
    },
    setSpectating(name) {
      if (name) {
        spectateLabel.hidden = false;
        spectateLabel.textContent = `You are down — watching ${name}`;
      } else {
        spectateLabel.hidden = true;
      }
    },
    showScoreboard(actors, score) {
      const rows = [...actors].sort((a, b) => (b.kills ?? 0) - (a.kills ?? 0));
      scoreboardBody.innerHTML = rows.map((a) => `<tr class="${a.team}"><td>${a.name}${a.alive ? '' : ' ✝'}</td><td>${a.team === 'warden' ? 'Wardens' : 'Jackals'}</td><td>${a.kills ?? 0}</td><td>${a.deaths ?? 0}</td><td>$${a.money}</td></tr>`).join('');
      el('scoreboard-title').textContent = `Wardens ${score.warden} — ${score.jackal} Jackals`;
      scoreboard.hidden = false;
    },
    hideScoreboard() {
      scoreboard.hidden = true;
    },
    showOverlay(mode, data = {}) {
      const copy = {
        start: ['Foundry Clash', 'Defend the Kestrel Foundry. The Jackals are coming with the Charge — hold the sites, or defuse it. First to 9 rounds.', 'Deploy'],
        paused: ['Paused', 'The match waits for no one — well, just this once, it waits for you.', 'Resume'],
        matchEnd: [data.title ?? 'Match over', data.copy ?? '', 'Play again'],
      }[mode];
      overlayTitle.textContent = copy[0];
      overlayCopy.textContent = copy[1];
      playButton.textContent = copy[2];
      overlay.hidden = false;
    },
    hideOverlay() {
      overlay.hidden = true;
    },
    drawRadar(actors, player, sites, bomb) {
      const S = 2; // px per metre
      radarCtx.clearRect(0, 0, radar.width, radar.height);
      radarCtx.fillStyle = 'rgba(20, 15, 11, 0.55)';
      radarCtx.fillRect(0, 0, radar.width, radar.height);
      const px = (x) => (x + 36) * S;
      const pz = (z) => (z + 24) * S;
      radarCtx.fillStyle = '#ff9a3c';
      radarCtx.font = 'bold 10px system-ui';
      radarCtx.fillText('A', px(sites.A.x) - 3, pz(sites.A.z) + 3);
      radarCtx.fillStyle = '#57c7d4';
      radarCtx.fillText('B', px(sites.B.x) - 3, pz(sites.B.z) + 3);
      if (bomb.visible) {
        radarCtx.fillStyle = '#ff4040';
        radarCtx.beginPath();
        radarCtx.arc(px(bomb.x), pz(bomb.z), 3.4, 0, Math.PI * 2);
        radarCtx.fill();
      }
      for (const actor of actors) {
        if (!actor.alive || actor.isPlayer) continue;
        if (actor.team !== 'warden') continue; // only teammates are tracked
        radarCtx.fillStyle = '#4da3ff';
        radarCtx.beginPath();
        radarCtx.arc(px(actor.position.x), pz(actor.position.z), 2.6, 0, Math.PI * 2);
        radarCtx.fill();
      }
      // The player: an arrow pointing the way they face.
      radarCtx.save();
      radarCtx.translate(px(player.x), pz(player.z));
      radarCtx.rotate(Math.atan2(-Math.sin(player.yaw), Math.cos(player.yaw)));
      radarCtx.fillStyle = '#f4ead8';
      radarCtx.beginPath();
      radarCtx.moveTo(0, -5);
      radarCtx.lineTo(3.6, 4);
      radarCtx.lineTo(-3.6, 4);
      radarCtx.closePath();
      radarCtx.fill();
      radarCtx.restore();
    },
  };
}
