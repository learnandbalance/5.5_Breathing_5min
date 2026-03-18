const PHASE_LEN = 5.5;
const CYCLE_LEN = PHASE_LEN * 2;

const phaseLabel = document.getElementById("phaseLabel");
const cornerLabel = document.getElementById("cornerLabel");
const soundToggle = document.getElementById("soundToggle");

let audioCtx = null;
let audioReady = false;

let master = null;
let inhaleBus = null;
let exhaleBus = null;

let modeVideo = false;
let durationMin = 5;
let durationSec = 5 * 60;

let running = false;
let rafId = null;
let t0 = 0;

let PRE_ROLL = 3.0;   // breathing starts at 3s
let POST_ROLL = 5.0;  // 5 seconds silent after end
let ended = false;
let endTimePerf = 0;
let lastPhase = "idle";

function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }
function easeInOut(t){ return t * t * (3 - 2 * t); }

function getParams(){
  const p = new URLSearchParams(location.search);
  const mode = (p.get("mode") || "").toLowerCase();
  const min = Number(p.get("min") || "5");
  return { mode, min };
}

function applyModeFromURL(){
  const { mode, min } = getParams();
  modeVideo = (mode === "video");

  if (Number.isFinite(min) && min > 0) durationMin = Math.round(min);
  durationSec = durationMin * 60;

  cornerLabel.textContent = `${durationMin} MIN • 5.5 Breathing`;

  // default: if video mode, auto-run (OBS)
  if (modeVideo){
    startVideoAuto();
  }
}

function setPhaseVisual(phase){
  if (phase === "inhale"){
    document.documentElement.style.setProperty("--blueOpacity", "1");
    document.documentElement.style.setProperty("--greenOpacity", "0");
  } else {
    document.documentElement.style.setProperty("--blueOpacity", "0");
    document.documentElement.style.setProperty("--greenOpacity", "1");
  }
}

function setOrbScale(scale){
  document.documentElement.style.setProperty("--scale", scale.toFixed(4));
}

// ---------------- AUDIO ----------------
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

  const noteMix = audioCtx.createGain();
  noteMix.gain.value = 1.0;

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
    gS.connect(noteMix);
    gW.connect(noteMix);

    oscs.push(s, w);
  });

  noteMix.connect(lp);
  lp.connect(gain);

  oscs.forEach(o => o.start(now));
  lfo.start(now);

  return { oscs, gain, out: gain };
}

function setPhaseAudio(phase){
  if (!audioReady) return;
  const now = audioCtx.currentTime;
  const FADE = 0.22;

  if (soundToggle && !soundToggle.checked){
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
    exhaleBus.gain.gain.setTargetAtTime(0.22, now, FADE);
  }
}

function stopAudioSoft(){
  if (!audioReady) return;
  const now = audioCtx.currentTime;
  inhaleBus.gain.gain.setTargetAtTime(0.0001, now, 0.07);
  exhaleBus.gain.gain.setTargetAtTime(0.0001, now, 0.07);
  master.gain.setTargetAtTime(0.0001, now, 0.09);
}

/* ✅ Chime: sadece session sonunda (başta yok) */
function playEndChime(){
  if (soundToggle && !soundToggle.checked) return;
  ensureAudio();
  const now = audioCtx.currentTime;

  const out = audioCtx.createGain();
  out.gain.setValueAtTime(0.0001, now);
  out.gain.exponentialRampToValueAtTime(0.30, now + 0.01);
  out.gain.exponentialRampToValueAtTime(0.0001, now + 1.4);
  out.connect(audioCtx.destination);

  const freqs = [784, 1176, 1568]; // slightly softer
  freqs.forEach((f, idx) => {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(f, now);
    const level = idx === 0 ? 0.22 : 0.10 / (idx + 0.2);
    g.gain.setValueAtTime(level, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 1.3);
    o.connect(g);
    g.connect(out);
    o.start(now);
    o.stop(now + 1.5);
  });
}

// ---------------- BREATH ----------------
function computeBreath(elapsed){
  const inCycle = elapsed % CYCLE_LEN;
  let phase, phaseProgress;

  if (inCycle < PHASE_LEN){
    phase = "inhale";
    phaseProgress = inCycle / PHASE_LEN;
  } else {
    phase = "exhale";
    phaseProgress = (inCycle - PHASE_LEN) / PHASE_LEN;
  }
  return { phase, phaseProgress };
}

function startVideoAuto(){
  running = true;
  ended = false;
  lastPhase = "idle";
  t0 = performance.now();
  rafId = requestAnimationFrame(loopVideo);
}

function loopVideo(){
  if (!running) return;

  const now = performance.now();
  const elapsedTotal = (now - t0) / 1000;

  if (ended){
    const post = (now - endTimePerf) / 1000;
    if (post >= POST_ROLL){
      running = false;
      cancelAnimationFrame(rafId);
      return;
    }
    setOrbScale(0.84);
    return (rafId = requestAnimationFrame(loopVideo));
  }

  if (elapsedTotal < PRE_ROLL){
    setOrbScale(0.84);
    setPhaseVisual("inhale");
    phaseLabel.style.opacity = "0"; // pre-roll'da yazı yok istersen
    return (rafId = requestAnimationFrame(loopVideo));
  }

  // breathing starts
  phaseLabel.style.opacity = "1";

  const breathElapsed = elapsedTotal - PRE_ROLL;

  if (breathElapsed >= durationSec){
    onSessionEnd();
    return;
  }

  const { phase, phaseProgress } = computeBreath(breathElapsed);

  if (phase !== lastPhase){
    setPhaseVisual(phase);
    phaseLabel.textContent = (phase === "inhale") ? "Inhale" : "Exhale";
    try{
      ensureAudio();
      setPhaseAudio(phase);
    } catch(e){}
    lastPhase = phase;
  }

  const t = easeInOut(clamp(phaseProgress, 0, 1));
  const minS = 0.78;
  const maxS = 1.08;

  const s = (phase === "inhale")
    ? (minS + (maxS - minS) * t)
    : (maxS - (maxS - minS) * t);

  setOrbScale(s);

  rafId = requestAnimationFrame(loopVideo);
}

function onSessionEnd(){
  ended = true;
  endTimePerf = performance.now();

  // session bitince inhale/exhale yazısı kalksın
  phaseLabel.style.opacity = "0";

  try { stopAudioSoft(); } catch(e){}
  try { playEndChime(); } catch(e){}

  setPhaseVisual("inhale");
  setOrbScale(0.84);
}

// init
applyModeFromURL();
