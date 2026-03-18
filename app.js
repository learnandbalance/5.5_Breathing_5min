const PHASE_LEN = 5.5;
const CYCLE_LEN = PHASE_LEN * 2;

const PRE_ROLL = 3.0;
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
  const hue = (phase === "inhale") ? "0deg" : "-60deg";
  document.documentElement.style.setProperty("--hue", hue);
}

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

/* ---------------- AUDIO ---------------- */
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

    s.connect(gS); w.connect(gW);
    gS.connect(mix); gW.connect(mix);

    s.start(now); w.start(now);
  });

  lfo.start(now);

  mix.connect(lp);
  lp.connect(gain);

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

/* ---------------- APP ---------------- */
window.addEventListener("DOMContentLoaded", () => {
  const phaseLabel = document.getElementById("phaseLabel");
  const cornerLabel = document.getElementById("cornerLabel");
  const startBtn = document.getElementById("startBtn");
  const pauseBtn = document.getElementById("pauseBtn");
  const resetBtn = document.getElementById("resetBtn");
  const soundBtn = document.getElementById("soundBtn");

  durationMin = getMinFromURL();
  durationSec = durationMin * 60;
  cornerLabel.textContent = `${durationMin} MIN • 5.5 Breathing`;

  function setPhaseLabel(text, visible=true){
    phaseLabel.textContent = text;
    phaseLabel.style.opacity = visible ? "1" : "0";
  }

  function start(){
    if (running) return;

    // ✅ Audio fail olsa bile animasyon başlamalı
    try { ensureAudio(); } catch(e) { /* ignore */ }

    running = true;
    lastPhase = "idle";

    startBtn.disabled = true;
    pauseBtn.disabled = false;
    resetBtn.disabled = false;

    t0 = performance.now();
    rafId = requestAnimationFrame(loop);
  }

  function pause(){
    if (!running) return;

    running = false;
    cancelAnimationFrame(rafId);

    const now = performance.now();
    pausedElapsed += (now - t0) / 1000;

    try { stopAudioSoft(); } catch(e){}

    startBtn.textContent = "Resume";
    startBtn.disabled = false;
    pauseBtn.disabled = true;
  }

  function resume(){
    if (running) return;

    try { ensureAudio(); } catch(e) { /* ignore */ }
    running = true;

    startBtn.disabled = true;
    pauseBtn.disabled = false;

    t0 = performance.now();
    lastPhase = "idle";
    rafId = requestAnimationFrame(loop);
  }

  function reset(){
    running = false;
    cancelAnimationFrame(rafId);

    pausedElapsed = 0;
    lastPhase = "idle";

    try { stopAudioSoft(); } catch(e){}

    startBtn.textContent = "Start";
    startBtn.disabled = false;
    pauseBtn.disabled = true;
    resetBtn.disabled = true;

    setHueForPhase("inhale");
    setOrbScale(0.84);
    setPhaseLabel("Ready", true);
  }

  function endSession(){
    running = false;
    cancelAnimationFrame(rafId);

    try { stopAudioSoft(); } catch(e){}

    setOrbScale(0.84);
    setPhaseLabel("", false);

    startBtn.textContent = "Start";
    startBtn.disabled = false;
    pauseBtn.disabled = true;
  }

  function loop(){
    if (!running) return;

    const now = performance.now();
    const elapsedTotal = pausedElapsed + (now - t0) / 1000;

    if (elapsedTotal < PRE_ROLL){
      setOrbScale(0.84);
      setHueForPhase("inhale");
      setPhaseLabel("", false);
      rafId = requestAnimationFrame(loop);
      return;
    }

    const breathElapsed = elapsedTotal - PRE_ROLL;

    if (breathElapsed >= durationSec){
      endSession();
      return;
    }

    const { phase, phaseProgress } = computeBreath(breathElapsed);

    if (phase !== lastPhase){
      setHueForPhase(phase);
      setPhaseLabel(phase === "inhale" ? "Inhale" : "Exhale", true);

      try { setPhaseAudio(phase); } catch(e){}

      lastPhase = phase;
    }

    const t = easeInOut(clamp(phaseProgress, 0, 1));
    const s = (phase === "inhale")
      ? (MIN_SCALE + (MAX_SCALE - MIN_SCALE) * t)
      : (MAX_SCALE - (MAX_SCALE - MIN_SCALE) * t);

    setOrbScale(s);
    rafId = requestAnimationFrame(loop);
  }

  // Buttons
  startBtn.addEventListener("click", () => {
    if (!running && startBtn.textContent === "Resume") resume();
    else start();
  });

  pauseBtn.addEventListener("click", pause);
  resetBtn.addEventListener("click", reset);

  soundBtn.addEventListener("click", () => {
    soundOn = !soundOn;
    soundBtn.textContent = soundOn ? "Sound: On" : "Sound: Off";
    soundBtn.setAttribute("aria-pressed", soundOn ? "true" : "false");
    if (!soundOn) { try { stopAudioSoft(); } catch(e){} }
    else if (audioReady && running && lastPhase !== "idle") { try { setPhaseAudio(lastPhase); } catch(e){} }
  });

  // initial
  setHueForPhase("inhale");
  setOrbScale(0.84);
  setPhaseLabel("Ready", true);
  resetBtn.disabled = true;
  pauseBtn.disabled = true;
});
