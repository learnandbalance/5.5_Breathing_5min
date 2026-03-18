// YouTube Video Mode + Interactive Mode
// Requirements implemented:
// - 5.5s inhale / 5.5s exhale
// - breathing starts at 3s (PRE_ROLL)
// - intro overlay visible for INTRO seconds (default 20; overridable via URL)
// - inhale blue, exhale green with smooth crossfade
// - "Inhale/Exhale" text under orb after intro
// - start chime at t=0, end chime at session end
// - after session end: 5s silent visual, orb stays, inhale/exhale label hidden

const PHASE_LEN = 5.5;
const CYCLE_LEN = PHASE_LEN * 2;

const orb = document.getElementById("orb");
const phaseLabel = document.getElementById("phaseLabel");
const introOverlay = document.getElementById("introOverlay");
const cornerLabel = document.getElementById("cornerLabel");

const soundToggle = document.getElementById("soundToggle");

// Interactive controls (optional, hidden in video mode)
const controlsPanel = document.getElementById("controlsPanel");
const presetBtns = [...document.querySelectorAll(".preset")];
const customMin = document.getElementById("customMin");
const startBtn = document.getElementById("startBtn");
const pauseBtn = document.getElementById("pauseBtn");
const resetBtn = document.getElementById("resetBtn");
const backBtn = document.getElementById("backBtn");

let audioCtx = null;
let audioReady = false;

// audio graph
let master = null;
let inhaleBus = null;
let exhaleBus = null;

// state
let modeVideo = false;
let durationMin = 5;
let durationSec = 5 * 60;

let running = false;
let rafId = null;
let t0 = 0;
let elapsedBefore = 0;
let lastPhase = "idle";

let PRE_ROLL = 3.0;      // breathing starts at 3s
let INTRO_SECONDS = 20;  // default; can override with URL intro=6
let POST_ROLL = 5.0;     // 5 seconds silent after end chime
let ended = false;
let endTimePerf = 0;

function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }
function easeInOut(t){ return t * t * (3 - 2 * t); }

// -------------------- URL params --------------------
function getParams(){
  const p = new URLSearchParams(location.search);
  const mode = (p.get("mode") || "").toLowerCase();
  const min = Number(p.get("min") || "5");
  const intro = p.get("intro");
  return { mode, min, intro };
}

function applyModeFromURL(){
  const { mode, min, intro } = getParams();

  modeVideo = (mode === "video");
  if (Number.isFinite(min) && min > 0) durationMin = Math.round(min);
  durationSec = durationMin * 60;

  if (intro !== null && intro !== undefined && intro !== ""){
    const v = Number(intro);
    if (Number.isFinite(v) && v >= 0) INTRO_SECONDS = v;
  }

  // set body class
  document.body.classList.toggle("video-mode", modeVideo);

  // corner label
  cornerLabel.textContent = `${durationMin} MIN • 5.5 Breathing`;

  // in video mode: auto-start (for OBS on Windows), audio will start if browser allows
  if (modeVideo){
    // hide inhale/exhale until intro ends
    phaseLabel.style.opacity = "0";
    startVideoAuto();
  } else {
    // interactive defaults
    setActivePreset(durationMin);
    if (customMin) customMin.value = String(durationMin);
  }
}

// -------------------- Orb color crossfade --------------------
function setPhaseVisual(phase){
  if (phase === "inhale"){
    document.documentElement.style.setProperty("--blueOpacity", "1");
    document.documentElement.style.setProperty("--greenOpacity", "0");
  } else if (phase === "exhale"){
    document.documentElement.style.setProperty("--blueOpacity", "0");
    document.documentElement.style.setProperty("--greenOpacity", "1");
  }
}

function setOrbScale(scale){
  document.documentElement.style.setProperty("--scale", scale.toFixed(4));
}

// -------------------- Audio --------------------
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

  // very gentle lfo (natural movement)
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

// gentle bell-like chime (start/end)
function playChime(){
  if (soundToggle && !soundToggle.checked) return;
  ensureAudio();
  const now = audioCtx.currentTime;

  const out = audioCtx.createGain();
  out.gain.setValueAtTime(0.0001, now);
  out.gain.exponentialRampToValueAtTime(0.35, now + 0.01);
  out.gain.exponentialRampToValueAtTime(0.0001, now + 1.6);
  out.connect(audioCtx.destination);

  // fundamentals + inharmonic partials for bell feel
  const freqs = [880, 1320, 1760, 2640];
  freqs.forEach((f, idx) => {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();

    o.type = "sine";
    o.frequency.setValueAtTime(f, now);

    const level = idx === 0 ? 0.28 : 0.12 / (idx + 0.2);
    g.gain.setValueAtTime(level, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 1.5);

    o.connect(g);
    g.connect(out);
    o.start(now);
    o.stop(now + 1.7);
  });

  // soft high shimmer
  const o2 = audioCtx.createOscillator();
  const g2 = audioCtx.createGain();
  const lp = audioCtx.createBiquadFilter();

  o2.type = "triangle";
  o2.frequency.setValueAtTime(3520, now);
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(2600, now);

  g2.gain.setValueAtTime(0.0001, now);
  g2.gain.exponentialRampToValueAtTime(0.06, now + 0.02);
  g2.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);

  o2.connect(lp);
  lp.connect(g2);
  g2.connect(out);

  o2.start(now);
  o2.stop(now + 1.0);
}

// -------------------- Breathing math --------------------
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

// -------------------- Video mode engine --------------------
function startVideoAuto(){
  // Start immediately for OBS capture.
  // Audio may still require gesture on some browsers; for Windows OBS this is okay.
  running = true;
  ended = false;
  elapsedBefore = 0;
  lastPhase = "idle";
  t0 = performance.now();

  // start chime at t=0
  try { playChime(); } catch(e){}

  rafId = requestAnimationFrame(loopVideo);
}

function loopVideo(){
  if (!running) return;

  const now = performance.now();
  const elapsedTotal = elapsedBefore + (now - t0) / 1000;

  // intro visibility
  if (elapsedTotal >= INTRO_SECONDS){
    if (!introOverlay.classList.contains("hidden")){
      introOverlay.classList.add("hidden");
      // show inhale/exhale label after intro
      phaseLabel.style.opacity = "1";
    }
  } else {
    // keep label hidden during intro
    phaseLabel.style.opacity = "0";
  }

  // if ended: keep silent visuals for POST_ROLL seconds then stop
  if (ended){
    const post = (now - endTimePerf) / 1000;
    if (post >= POST_ROLL){
      running = false;
      cancelAnimationFrame(rafId);
      // keep orb visible; no label
      return;
    }
    // keep orb stable during post-roll
    setOrbScale(0.84);
    return (rafId = requestAnimationFrame(loopVideo));
  }

  // Pre-roll: first PRE_ROLL seconds keep orb calm (no breathing)
  if (elapsedTotal < PRE_ROLL){
    setOrbScale(0.84);
    // keep default blue during pre-roll (calm)
    setPhaseVisual("inhale");
    return (rafId = requestAnimationFrame(loopVideo));
  }

  // breathing elapsed starts after pre-roll
  const breathElapsed = elapsedTotal - PRE_ROLL;

  // session ends after durationSec
  if (breathElapsed >= durationSec){
    onSessionEnd();
    return;
  }

  const { phase, phaseProgress } = computeBreath(breathElapsed);

  // phase change actions
  if (phase !== lastPhase){
    // Visual + audio crossfade
    setPhaseVisual(phase);

    // Set label (only if intro finished)
    if (elapsedTotal >= INTRO_SECONDS){
      phaseLabel.textContent = (phase === "inhale") ? "Inhale" : "Exhale";
    }

    // Audio
    try{
      ensureAudio();
      setPhaseAudio(phase);
    } catch(e){}

    lastPhase = phase;
  }

  // scale animation
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
  // Stop breathing; play end chime; hide label; keep orb visible
  ended = true;
  endTimePerf = performance.now();

  // hide label immediately
  phaseLabel.style.opacity = "0";

  // stop pad softly
  try { stopAudioSoft(); } catch(e){}

  // end chime
  try { playChime(); } catch(e){}

  // keep last color calm (blue) during post-roll
  setPhaseVisual("inhale");
  setOrbScale(0.84);
}

// -------------------- Interactive mode (kept for your use) --------------------
function setActivePreset(min){
  presetBtns.forEach(b => b.classList.toggle("active", Number(b.dataset.min) === min));
}

function startInteractive(){
  if (running) return;
  running = true;
  ended = false;
  lastPhase = "idle";
  t0 = performance.now();
  elapsedBefore = 0;

  ensureAudio();
  playChime(); // optional pleasant start also here

  startBtn.disabled = true;
  pauseBtn.disabled = false;
  resetBtn.disabled = false;
  backBtn.disabled = false;
  customMin.disabled = true;
  presetBtns.forEach(b => b.disabled = true);

  rafId = requestAnimationFrame(loopInteractive);
}

function loopInteractive(){
  if (!running) return;

  const now = performance.now();
  const elapsed = elapsedBefore + (now - t0) / 1000;

  const { phase, phaseProgress } = computeBreath(elapsed);

  if (phase !== lastPhase){
    setPhaseVisual(phase);
    phaseLabel.textContent = (phase === "inhale") ? "Inhale" : "Exhale";
    setPhaseAudio(phase);
    lastPhase = phase;
  }

  const t = easeInOut(clamp(phaseProgress, 0, 1));
  const minS = 0.78;
  const maxS = 1.08;
  const s = (phase === "inhale")
    ? (minS + (maxS - minS) * t)
    : (maxS - (maxS - minS) * t);

  setOrbScale(s);

  rafId = requestAnimationFrame(loopInteractive);
}

function pauseInteractive(){
  if (!running) return;
  running = false;
  cancelAnimationFrame(rafId);

  const pausedAt = performance.now();
  elapsedBefore += (pausedAt - t0) / 1000;

  stopAudioSoft();

  startBtn.textContent = "Resume";
  startBtn.disabled = false;
  pauseBtn.disabled = true;
}

function resumeInteractive(){
  if (running) return;
  running = true;
  ensureAudio();

  startBtn.disabled = true;
  pauseBtn.disabled = false;

  t0 = performance.now();
  lastPhase = "idle";
  rafId = requestAnimationFrame(loopInteractive);
}

function resetInteractive(){
  running = false;
  cancelAnimationFrame(rafId);
  stopAudioSoft();

  elapsedBefore = 0;
  lastPhase = "idle";
  ended = false;

  startBtn.textContent = "Start";
  startBtn.disabled = false;
  pauseBtn.disabled = true;
  resetBtn.disabled = true;
  backBtn.disabled = true;

  customMin.disabled = false;
  presetBtns.forEach(b => b.disabled = false);

  // reset visuals
  setPhaseVisual("inhale");
  setOrbScale(0.84);
  phaseLabel.textContent = "Inhale";
}

function backOneCycle(){
  const back = CYCLE_LEN;
  if (running){
    const now = performance.now();
    const elapsed = elapsedBefore + (now - t0) / 1000;
    elapsedBefore = Math.max(0, elapsed - back);
    t0 = performance.now();
    lastPhase = "idle";
  } else {
    elapsedBefore = Math.max(0, elapsedBefore - back);
  }
}

// wire interactive
function bindInteractive(){
  if (!startBtn) return;

  presetBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const min = Number(btn.dataset.min);
      durationMin = min;
      durationSec = durationMin * 60;
      if (customMin) customMin.value = String(min);
      setActivePreset(min);
      cornerLabel.textContent = `${durationMin} MIN • 5.5 Breathing`;
      resetBtn.disabled = true;
      backBtn.disabled = true;
    });
  });

  if (customMin){
    customMin.addEventListener("change", () => {
      const v = clamp(Number(customMin.value || 5), 1, 240);
      durationMin = v;
      durationSec = durationMin * 60;
      setActivePreset(-1);
      cornerLabel.textContent = `${durationMin} MIN • 5.5 Breathing`;
      resetBtn.disabled = true;
      backBtn.disabled = true;
    });
  }

  startBtn.addEventListener("click", () => {
    if (!running && startBtn.textContent === "Resume") resumeInteractive();
    else startInteractive();
  });

  pauseBtn.addEventListener("click", pauseInteractive);
  resetBtn.addEventListener("click", resetInteractive);
  backBtn.addEventListener("click", backOneCycle);

  if (soundToggle){
    soundToggle.addEventListener("change", () => {
      if (!audioReady) return;
      if (!soundToggle.checked) stopAudioSoft();
      else if (running && lastPhase !== "idle") setPhaseAudio(lastPhase);
    });
  }

  // initial UI
  setPhaseVisual("inhale");
  setOrbScale(0.84);
  resetBtn.disabled = true;
  backBtn.disabled = true;
}

// init
applyModeFromURL();
bindInteractive();