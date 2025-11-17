// ==============================
// Configuration
// ==============================
const SONGS_JSON_URL = 'https://pub-050fb801777b4853a0c36256d7ab9b36.r2.dev/songs.json';
const SAMPLE_RATE = 48000;

// ==============================
// DFPWM Decoder
// ==============================
class DFPWM {
  constructor() {
    this.response = 0;
    this.level = 0;
    this.lastbit = false;
    this.flastlevel = 0;
    this.lpflevel = 0;

    // constants
    this.RESP_PREC = 10;
    this.LPF_STRENGTH = 140;
    this.MIN_RESPONSE = 2 << (this.RESP_PREC - 8);
    this.MAX_RESPONSE = (1 << this.RESP_PREC) - 1;
    this.RESP_HALF = 1 << (this.RESP_PREC - 1);
    this.SCALE = 1 / 128.0;
  }

  decode(uint8Array) {
    const out = new Float32Array(uint8Array.length * 8);
    const { RESP_PREC, LPF_STRENGTH, MIN_RESPONSE, MAX_RESPONSE, RESP_HALF, SCALE } = this;
    let { response, level, lastbit, flastlevel, lpflevel } = this;
    let pos = 0;

    for (let byte of uint8Array) {
      for (let b = 0; b < 8; b++, byte >>= 1) {
        const bit = (byte & 1) !== 0;
        const target = bit ? 127 : -128;

        // Integrator
        level += ((response * (target - level) + RESP_HALF) >> RESP_PREC);
        if (level === target - 1) level++;

        // Adaptive response
        const same = bit === lastbit;
        const rtarget = same ? MAX_RESPONSE : 0;
        if (response !== rtarget) {
          response += same ? 1 : -1;
          response = Math.min(Math.max(response, MIN_RESPONSE), MAX_RESPONSE);
        }

        // Low-pass
        const blended = same ? level : ((flastlevel + level + 1) >> 1);
        flastlevel = level;
        lpflevel += ((LPF_STRENGTH * (blended - lpflevel) + 0x80) >> 8);
        out[pos++] = lpflevel * SCALE;

        lastbit = bit;
      }
    }

    // persist state
    Object.assign(this, { response, level, lastbit, flastlevel, lpflevel });
    return out.subarray(0, pos);
  }
}

// ==============================
// UI + Global State
// ==============================
let songs = [];
let selectedIndex = -1;

const listEl = document.getElementById('list');
const refreshBtn = document.getElementById('refreshBtn');
const playBtn = document.getElementById('playBtn');
const pauseBtn = document.getElementById('pauseBtn');
const stopBtn = document.getElementById('stopBtn');
const removeBtn = document.getElementById('removeBtn');
const volumeEl = document.getElementById('volume');
const barEl = document.getElementById('bar');
const installBtn = document.getElementById('installBtn');

let audioCtx = null;
let gainNode = null;
let currentSource = null;
let isPlaying = false;
let isPaused = false;
let startTime = 0;
let pauseOffset = 0;
let totalDuration = 0;

// ==============================
// Audio Control
// ==============================
function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
    gainNode = audioCtx.createGain();
    gainNode.gain.value = parseFloat(volumeEl.value);
    gainNode.connect(audioCtx.destination);
  }
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
}

function stop() {
  if (currentSource) {
    try { currentSource.stop(); } catch {}
    currentSource.disconnect();
    currentSource = null;
  }
  isPlaying = false;
  isPaused = false;
  pauseOffset = 0;
  barEl.style.width = '0%';
}

function pause() {
  if (!isPlaying) return;
  if (!isPaused) {
    audioCtx.suspend();
    isPaused = true;
    pauseOffset = audioCtx.currentTime - startTime;
  } else {
    audioCtx.resume();
    isPaused = false;
    startTime = audioCtx.currentTime - pauseOffset;
  }
}

// ==============================
// Playback
// ==============================
async function playSelected() {
  if (selectedIndex < 0 || selectedIndex >= songs.length) return;
  stop();
  ensureAudio();
  await playUrlStreamed(songs[selectedIndex].url);
}

async function playUrlStreamed(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const reader = res.body.getReader();
  const decoder = new DFPWM();
  const chunks = [];
  let totalSamples = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const pcm = decoder.decode(value);
    chunks.push(pcm);
    totalSamples += pcm.length;
  }

  playBuffered(chunks, totalSamples);
}

function playBuffered(chunks, totalSamples) {
  const audioBuffer = audioCtx.createBuffer(1, totalSamples, SAMPLE_RATE);
  const data = audioBuffer.getChannelData(0);

  let offset = 0;
  for (const c of chunks) {
    data.set(c, offset);
    offset += c.length;
  }

  totalDuration = audioBuffer.duration;
  const src = audioCtx.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(gainNode);
  src.start();

  startTime = audioCtx.currentTime;
  currentSource = src;
  isPlaying = true;
  isPaused = false;

  src.onended = () => {
    isPlaying = false;
    currentSource = null;
    barEl.style.width = '0%';
  };

  updateProgress();
}

function updateProgress() {
  if (!isPlaying) return;
  if (!isPaused) {
    const elapsed = audioCtx.currentTime - startTime;
    const pct = Math.min(100 * (elapsed / totalDuration), 100);
    barEl.style.width = pct.toFixed(1) + '%';
  }
  requestAnimationFrame(updateProgress);
}

// ==============================
// UI and Data
// ==============================
function cleanTitle(raw) {
  try {
    let title = raw.split('/').pop().replace(/\.dfpwm$/i, '');
    return title.replace(/\(.*?\)|\[.*?\]/g, '').trim();
  } catch { return raw; }
}

function renderList() {
  listEl.innerHTML = '';
  songs.forEach((s, i) => {
    const div = document.createElement('div');
    div.className = 'song' + (i === selectedIndex ? ' active' : '');
    div.textContent = cleanTitle(s.title || s.url);
    div.onclick = () => { selectedIndex = i; renderList(); };
    listEl.appendChild(div);
  });
}

async function fetchSongs() {
  try {
    const res = await fetch(SONGS_JSON_URL);
    songs = await res.json();
    selectedIndex = songs.length > 0 ? 0 : -1;
    renderList();
  } catch (e) {
    listEl.innerHTML = `<div style="padding:12px;color:#a00">Failed to fetch songs: ${e.message}</div>`;
  }
}

// ==============================
// Event Bindings
// ==============================
volumeEl.oninput = () => { if (gainNode) gainNode.gain.value = parseFloat(volumeEl.value); };
refreshBtn.onclick = fetchSongs;
playBtn.onclick = playSelected;
pauseBtn.onclick = pause;
stopBtn.onclick = stop;
removeBtn.onclick = () => {
  if (selectedIndex < 0) return;
  songs.splice(selectedIndex, 1);
  if (selectedIndex >= songs.length) selectedIndex--;
  renderList();
};

// ==============================
// Install + Service Worker
// ==============================
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
  installBtn.style.display = 'inline-block';
});

installBtn.onclick = async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  installBtn.style.display = 'none';
};

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js')
    .then(() => console.log('SW registered'))
    .catch(() => {});
}

// ==============================
// Init
// ==============================
fetchSongs();
