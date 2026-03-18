const PHASE_LEN = 5.5;
const CYCLE_LEN = PHASE_LEN * 2;

const phaseLabel = document.getElementById("phaseLabel");
const cornerLabel = document.getElementById("cornerLabel");

const startBtn = document.getElementById("startBtn");
const pauseBtn = document.getElementById("pauseBtn");
const resetBtn = document.getElementById("resetBtn");
const soundBtn = document.getElementById("soundBtn");

const PRE_ROLL = 3.0;     // breathing starts after 3 seconds
const MIN_SCALE = 0.78;
const MAX_SCALE = 1.08;

let durationMin = 5;
let durationSec = 5 * 60;

let running = false;
let rafId = null;

let audioCtx = null;
let audioReady = false;
let soundOn = true;

let master = null;
let inhaleBus = null;
let exhaleBus = null;

let t0 = 0;
let pausedElapsed = 0;
let lastPhase = "idle";
let ended = false;

function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }
function easeInOut(t){ return t * t * (3 - 2 * t); }

function getMinFromURL(){
  const p = new URLSearchParams(location.search);
  const min = Number(p.get("min") || "5");
  if (Number.isFinite(min) && min > 0) return Math.round(min);
  return 5;
}

function setOrbScale(scale){
  document.documentElement.style.setProperty("--scale", scale.toFixed(4));
}

function setHueForPhase(phase){
  // inhale blue = 0deg
  // exhale green = about -60deg (blue -> green shift)
  const hue = (phase === "inhale") ? "0deg" : "-60deg";
  document.documentElement.style.setProperty("--hue", hue);
}

function setPhaseLabel(text, visible=true){
  phaseLabel.textContent = text;
  phaseLabel.style.opacity = visible ? "1" : "0";
}

/* ---------------- AUDIO (pad) ---------------- */
function ensureAudio(){
  if (!audioCtx){
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === "suspended") audioCtx.resume();

  if (!audioReady){
    buildAudioGraph();
    audioReady = true;
  }
}

function buildAudioGraph(){
  const now = audioCtx.currentTime;

  master = audioCtx.createGain();
  master.gain.setValueAtTime(0.0001, now);
  master.connect(audioCtx.destination);

  // subtle room
  const delay = audioCtx.createDelay(0.35);
  delay.delayTime.value = 0.18;

  const fb = audioCtx.createGain();
  fb.gain.value = 0.18;

  const fbLP = audioCtx.createBiquadFilter();
  fbLP.type = "lowpass";
  fbLP.frequency.value = 1200;
  fbLP.Q.value = 0.7;

  delay.connect(fbLP);
  fbLP.connect(fb);
  fb.connect(delay);

  const wet = audioCtx.createGain();
  wet.gain.value = 0.22;

  delay.connect(wet);
  wet.connect(master);

  inhaleBus = createChordBus({ freqs: [220.00, 277.18, 329.63], warmth: 1400 });
  exhaleBus = createChordBus({ freqs: [293.66, 369.99, 440.00], warmth: 1700 });

  inhaleBus.out.connect(master);
  exhaleBus.out.connect(master);
  inhaleBus.out.connect(delay);
  exhaleBus.out.connect(delay);

  inhaleBus.gain.gain.setValueAtTime(0.0001, now);
  exhaleBus.gain.gain.setValueAtTime(0.0001, now);
}

function createChordBus({ freqs, warmth }){
  const now = audioCtx.currentTime;

  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.0001, now);

  const lp = audioCtx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(warmth, now);
  lp.Q.setValueAtTime(0.85, now);

  const lfo = audioCtx.createOscillator();
  const lfoGain = audioCtx.createGain();
  lfo.type = "sine";
  lfo.frequency.value = 0.18;
  lfoGain.gain.value = 3.0;
  lfo.connect(lfoGain);

  const mix = audioCtx.createGain();
  mix.gain.value = 1.0;

  const oscs = [];

  freqs.forEach((f, i) => {
    const s = audioCtx.createOscillator();
    s.type = "sine";
    s.frequency.setValueAtTime(f, now);
    s.detune.setValueAtTime((i - 1) * 1.5, now);
    lfoGain.connect(s.detune);

    const w = audioCtx.createOscillator();
    w.type = "sawtooth";
    w.frequency.setValueAtTime(f, now);
    w.detune.setValueAtTime((1 - i) * 1.0, now);
    lfoGain.connect(w.detune);

    const gS = audioCtx.createGain();
    const gW = audioCtx.createGain();
    gS.gain.value = 0.33 + (i === 1 ? 0.05 : 0.0);
    gW.gain.value = 0.05;

    s.connect(gS);
    w.connect(gW);
    gS.connect(mix);
    gW.connect(mix);

    oscs.push(s, w);
  });

  mix.connect(lp);
  lp.connect(gain);

  oscs.forEach(o => o.start(now));
  lfo.start(now);

  return { out: gain, gain };
}

function setPhaseAudio(phase){
  if (!audioReady) return;
  const now = audioCtx.currentTime;
  const FADE = 0.22;

  if (!soundOn){
    inhaleBus.gain.gain.setTargetAtTime(0.0001, now, 0.06);
    exhaleBus.gain.gain.setTargetAtTime(0.0001, now, 0.06);
    master.gain.setTargetAtTime(0.0001, now, 0.06);
    return;
  }

  master.gain.setTargetAtTime(0.22, now, 0.08);

  if (phase === "inhale"){
    inhaleBus.gain.gain.setTargetAtTime(0.22, now, FADE);
    exhaleBus.gain.gain.setTargetAtTime(0.0001, now, FADE);
  } else {
    inhaleBus.gain.gain.setTargetAtTime(0.0001, now, FADE);
