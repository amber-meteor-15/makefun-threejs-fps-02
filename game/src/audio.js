// All sound is synthesised with WebAudio: no audio files ship with the game. Short
// filtered-noise bursts make gunfire and impacts, oscillators make beeps, clicks and
// the round stingers. The context is created lazily on the first user gesture, and
// every call is a no-op until then, so the simulation never waits on audio.
export function createAudio() {
  let context = null;
  let master = null;
  let noiseBuffer = null;

  function ensure() {
    if (context) {
      if (context.state === 'suspended') context.resume();
      return true;
    }
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return false;
    context = new Ctor();
    master = context.createGain();
    master.gain.value = 0.5;
    master.connect(context.destination);
    const length = context.sampleRate * 0.5;
    noiseBuffer = context.createBuffer(1, length, context.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
    return true;
  }

  // One noise burst through a band filter: the workhorse for shots and impacts.
  // volume scales with distance for sounds that are not the player's own.
  function burst({ at = 0, dur = 0.12, freq = 1800, q = 0.8, type = 'bandpass', gain = 0.5, sweep = 0 }) {
    if (!context) return;
    const t0 = context.currentTime + at;
    const source = context.createBufferSource();
    source.buffer = noiseBuffer;
    source.loop = true;
    const filter = context.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(freq, t0);
    if (sweep) filter.frequency.exponentialRampToValueAtTime(Math.max(40, freq + sweep), t0 + dur);
    filter.Q.value = q;
    const amp = context.createGain();
    amp.gain.setValueAtTime(gain, t0);
    amp.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    source.connect(filter).connect(amp).connect(master);
    source.start(t0, Math.random() * 0.2);
    source.stop(t0 + dur + 0.02);
  }

  function tone({ at = 0, dur = 0.09, freq = 880, type = 'square', gain = 0.16, sweep = 0 }) {
    if (!context) return;
    const t0 = context.currentTime + at;
    const osc = context.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (sweep) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + sweep), t0 + dur);
    const amp = context.createGain();
    amp.gain.setValueAtTime(gain, t0);
    amp.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(amp).connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  function distanceGain(distance) {
    return Math.max(0, Math.min(1, 14 / (6 + distance)));
  }

  return {
    unlock() {
      ensure();
    },
    shot(kind, distance = 0) {
      if (!context) return;
      const own = distance === 0;
      const g = own ? 0.55 : 0.4 * distanceGain(distance);
      if (g <= 0.01) return;
      if (kind === 'scatter') {
        burst({ dur: 0.22, freq: 900, q: 0.5, gain: g, sweep: -500 });
        burst({ dur: 0.1, freq: 2600, q: 1, gain: g * 0.5 });
      } else if (kind === 'longbow') {
        burst({ dur: 0.3, freq: 700, q: 0.6, gain: g, sweep: -420 });
        burst({ dur: 0.06, freq: 3400, q: 2, gain: g * 0.6 });
        tone({ dur: 0.05, freq: 160, type: 'triangle', gain: g * 0.4, sweep: -60 });
      } else if (kind === 'sidearm') {
        burst({ dur: 0.1, freq: 2100, q: 0.9, gain: g * 0.8 });
        burst({ dur: 0.05, freq: 800, q: 1, gain: g * 0.5, sweep: -300 });
      } else {
        burst({ dur: 0.14, freq: 1500, q: 0.7, gain: g, sweep: -700 });
        burst({ dur: 0.05, freq: 3200, q: 2, gain: g * 0.45 });
      }
    },
    dryFire() {
      tone({ dur: 0.04, freq: 1400, type: 'square', gain: 0.12 });
    },
    reload() {
      tone({ dur: 0.05, freq: 500, type: 'square', gain: 0.14 });
      tone({ at: 0.16, dur: 0.05, freq: 340, type: 'square', gain: 0.14 });
      tone({ at: 0.34, dur: 0.06, freq: 720, type: 'square', gain: 0.16 });
    },
    draw() {
      burst({ dur: 0.07, freq: 1200, q: 2, gain: 0.12 });
    },
    hit(killed) {
      tone({ dur: 0.05, freq: killed ? 1560 : 1180, type: 'sine', gain: 0.22 });
      if (killed) tone({ at: 0.05, dur: 0.08, freq: 1980, type: 'sine', gain: 0.2 });
    },
    hurt() {
      burst({ dur: 0.12, freq: 300, q: 1, type: 'lowpass', gain: 0.4 });
    },
    headshotDing() {
      tone({ dur: 0.07, freq: 2093, type: 'sine', gain: 0.18 });
    },
    footstep(run) {
      burst({ dur: 0.05, freq: run ? 500 : 380, q: 1.2, type: 'lowpass', gain: run ? 0.1 : 0.05 });
    },
    jump() {
      burst({ dur: 0.06, freq: 700, q: 1.5, gain: 0.06, sweep: 300 });
    },
    throwWhoosh() {
      burst({ dur: 0.18, freq: 900, q: 1.4, gain: 0.12, sweep: 900 });
    },
    explosion(distance = 0) {
      if (!context) return;
      const g = distance === 0 ? 0.9 : 0.8 * distanceGain(distance);
      burst({ dur: 0.7, freq: 220, q: 0.4, type: 'lowpass', gain: g, sweep: -120 });
      burst({ dur: 0.25, freq: 900, q: 0.5, gain: g * 0.6, sweep: -600 });
      tone({ dur: 0.5, freq: 70, type: 'sine', gain: g * 0.7, sweep: -30 });
    },
    flashPop(distance = 0) {
      if (!context) return;
      const g = distance === 0 ? 0.5 : 0.45 * distanceGain(distance);
      burst({ dur: 0.16, freq: 4000, q: 0.7, type: 'highpass', gain: g });
      tone({ dur: 0.3, freq: 5200, type: 'sine', gain: g * 0.35, sweep: -2600 });
    },
    beep(final = false) {
      tone({ dur: final ? 0.3 : 0.07, freq: final ? 1320 : 990, type: 'square', gain: 0.14 });
    },
    plantDone() {
      tone({ dur: 0.08, freq: 880, type: 'square', gain: 0.16 });
      tone({ at: 0.1, dur: 0.12, freq: 1320, type: 'square', gain: 0.16 });
    },
    buy() {
      tone({ dur: 0.05, freq: 1040, type: 'sine', gain: 0.16 });
      tone({ at: 0.05, dur: 0.07, freq: 1560, type: 'sine', gain: 0.14 });
    },
    denied() {
      tone({ dur: 0.09, freq: 220, type: 'square', gain: 0.14 });
    },
    roundWin() {
      tone({ dur: 0.12, freq: 659, type: 'triangle', gain: 0.2 });
      tone({ at: 0.12, dur: 0.12, freq: 880, type: 'triangle', gain: 0.2 });
      tone({ at: 0.24, dur: 0.22, freq: 1318, type: 'triangle', gain: 0.22 });
    },
    roundLose() {
      tone({ dur: 0.14, freq: 523, type: 'triangle', gain: 0.2 });
      tone({ at: 0.14, dur: 0.14, freq: 415, type: 'triangle', gain: 0.2 });
      tone({ at: 0.28, dur: 0.26, freq: 311, type: 'triangle', gain: 0.2 });
    },
    click() {
      tone({ dur: 0.03, freq: 1600, type: 'square', gain: 0.08 });
    },
  };
}
