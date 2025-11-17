const SONGS_JSON_URL = 'https://pub-050fb801777b4853a0c36256d7ab9b36.r2.dev/songs.json';
const SAMPLE_RATE = 48000;
const SONG_CACHE_NAME = 'dfpwm-song-cache-v1';
const LIBRARY_STORAGE_KEY = 'dfpwm-library-cache-v1';
const APP_STATE_KEY = 'dfpwm-player-state-v1';

const view = document.body.dataset.view || 'main';
const audioEl = document.getElementById('audio');
if (audioEl) {
  audioEl.controls = false;
  audioEl.preload = 'auto';
  audioEl.crossOrigin = 'anonymous';
}

// =============================================
// Utility helpers
// =============================================
const formatTime = (seconds = 0) => {
  if (!Number.isFinite(seconds)) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
};

const cleanTitle = (raw = '') => {
  try {
    const stripped = raw.split('/').pop()?.replace(/\.dfpwm$/i, '') || raw;
    return stripped.replace(/\(.*?\)|\[.*?\]/g, '').trim();
  } catch (err) {
    return raw;
  }
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// =============================================
// DFPWM Decoder
// =============================================
class DFPWM {
  constructor() {
    this.response = 0;
    this.level = 0;
    this.lastbit = false;
    this.flastlevel = 0;
    this.lpflevel = 0;

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

        level += ((response * (target - level) + RESP_HALF) >> RESP_PREC);
        if (level === target - 1) level++;

        const same = bit === lastbit;
        const rtarget = same ? MAX_RESPONSE : 0;
        if (response !== rtarget) {
          response += same ? 1 : -1;
          response = Math.min(Math.max(response, MIN_RESPONSE), MAX_RESPONSE);
        }

        const blended = same ? level : ((flastlevel + level + 1) >> 1);
        flastlevel = level;
        lpflevel += ((LPF_STRENGTH * (blended - lpflevel) + 0x80) >> 8);
        out[pos++] = lpflevel * SCALE;
        lastbit = bit;
      }
    }

    Object.assign(this, { response, level, lastbit, flastlevel, lpflevel });
    return out.subarray(0, pos);
  }
}

// ==============================
// Globals
// ==============================
let publicSongs = [];
let localSongs = [];
let selectedList = 'public';
let selectedIndex = -1;

const listPublicEl = document.getElementById('list-public');
const listLocalEl = document.getElementById('list-local');
const refreshBtn = document.getElementById('refreshBtn');
const playBtn = document.getElementById('playBtn');
const pauseBtn = document.getElementById('pauseBtn');
const stopBtn = document.getElementById('stopBtn');
const removeBtn = document.getElementById('removeBtn');
const cacheBtn = document.getElementById('cacheBtn');
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

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const sample = clamp(samples[i], -1, 1);
    const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    view.setInt16(offset, intSample, true);
  }
  return buffer;
};

const dfpwmBufferToObjectUrl = async (arrayBuffer) => {
  const samples = dfpwmBufferToFloat32(arrayBuffer);
  const wavBuffer = float32ToWavBuffer(samples, SAMPLE_RATE);
  const blob = new Blob([wavBuffer], { type: 'audio/wav' });
  return URL.createObjectURL(blob);
};

// =============================================
// Library + Cache abstractions
// =============================================
class SongLibrary {
  constructor(storageKey) {
    this.storageKey = storageKey;
    this.songs = [];
  }

  normalize(entry, index = 0) {
    const title = cleanTitle(entry.title || entry.url || `Track ${index + 1}`);
    return {
      id: entry.id || entry.url || `song-${index}`,
      url: entry.url,
      title,
      rawTitle: entry.title || entry.url || title,
    };
  }

  setSongs(list = []) {
    this.songs = list.map((song, idx) => this.normalize(song, idx)).filter(Boolean);
    return this.songs;
  }

  loadFromStorage() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return this.setSongs(parsed);
    } catch (err) {
      console.warn('Failed to parse cached library', err);
      return [];
    }
  }

// ==============================
// Playback
// ==============================
async function playSelected() {
  const list = selectedList === 'public' ? publicSongs : localSongs;
  if (selectedIndex < 0 || selectedIndex >= list.length) return;
  stop();
  ensureAudio();
  await playUrlStreamed(list[selectedIndex].url);
}

class SongCache {
  constructor(cacheName) {
    this.cacheName = cacheName;
    this.supported = 'caches' in window;
    this.cachePromise = this.supported ? caches.open(this.cacheName) : null;
  }

  async _cache() {
    return this.cachePromise ? this.cachePromise : null;
  }

  async has(url) {
    const cache = await this._cache();
    if (!cache) return false;
    const match = await cache.match(url);
    return Boolean(match);
  }

  async get(url) {
    const cache = await this._cache();
    if (cache) {
      const cached = await cache.match(url);
      if (cached) return cached.arrayBuffer();
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = await res.arrayBuffer();
    if (cache) {
      try {
        await cache.put(url, new Response(buffer.slice(0), { headers: { 'Content-Type': 'application/octet-stream' } }));
      } catch (err) {
        console.warn('Failed to cache song', err);
      }
    }
    return buffer;
  }

  async put(url) {
    await this.get(url);
  }

  async remove(url) {
    const cache = await this._cache();
    if (!cache) return false;
    return cache.delete(url);
  }

  async list() {
    const cache = await this._cache();
    if (!cache) return [];
    const keys = await cache.keys();
    return keys.map((req) => req.url);
  }

  async clear() {
    if (!this.supported) return;
    await caches.delete(this.cacheName);
    this.cachePromise = caches.open(this.cacheName);
  }
}

class PlaybackQueue {
  constructor() {
    this.items = [];
    this.currentIndex = -1;
  }

  serialize() {
    return {
      items: this.items.map((item) => ({ title: item.title, url: item.url, rawTitle: item.rawTitle })),
      currentIndex: this.currentIndex,
    };
  }

  load(snapshot = { items: [], currentIndex: -1 }) {
    this.items = (snapshot.items || []).map((item, idx) => ({
      title: item.title,
      url: item.url,
      rawTitle: item.rawTitle || item.title,
      id: item.url || `restored-${idx}`,
    }));
    this.currentIndex = clamp(snapshot.currentIndex ?? -1, -1, this.items.length - 1);
  }

  enqueue(song) {
    if (!song) return;
    this.items.push(song);
    if (this.currentIndex === -1) this.currentIndex = 0;
  }

  enqueueMany(songs = []) {
    songs.forEach((song) => this.enqueue(song));
  }

  clear() {
    this.items = [];
    this.currentIndex = -1;
  }

  size() {
    return this.items.length;
  }

  getCurrent() {
    if (this.currentIndex < 0) return null;
    return this.items[this.currentIndex] || null;
  }

  next(repeatMode = 'off') {
    if (!this.items.length) return null;
    if (repeatMode === 'track' && this.currentIndex !== -1) {
      return this.items[this.currentIndex];
    }
    if (this.currentIndex < 0) {
      this.currentIndex = 0;
      return this.items[this.currentIndex];
    }
    if (this.currentIndex + 1 < this.items.length) {
      this.currentIndex++;
      return this.items[this.currentIndex];
    }
    if (repeatMode === 'queue') {
      this.currentIndex = 0;
      return this.items[this.currentIndex];
    }
    return null;
  }

  previous(repeatMode = 'off') {
    if (!this.items.length) return null;
    if (repeatMode === 'track' && this.currentIndex !== -1) {
      return this.items[this.currentIndex];
    }
    if (this.currentIndex > 0) {
      this.currentIndex--;
      return this.items[this.currentIndex];
    }
    this.currentIndex = 0;
    return this.items[this.currentIndex];
  }

  jump(index) {
    if (index < 0 || index >= this.items.length) return null;
    this.currentIndex = index;
    return this.items[index];
  }

  remove(index) {
    if (index < 0 || index >= this.items.length) return;
    this.items.splice(index, 1);
    if (!this.items.length) {
      this.currentIndex = -1;
      return;
    }
    if (index < this.currentIndex) this.currentIndex--;
    if (this.currentIndex >= this.items.length) this.currentIndex = this.items.length - 1;
  }

  shuffle() {
    if (this.items.length <= 1) return;
    const current = this.getCurrent();
    const array = this.items.slice();
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    this.items = array;
    if (current) {
      const idx = this.items.findIndex((item) => item.url === current.url);
      if (idx > -1) this.currentIndex = idx;
    }
  }
}

class PlayerEngine extends EventTarget {
  constructor(audio, cache) {
    super();
    this.audio = audio;
    this.cache = cache;
    this.objectUrl = null;
    this.currentSong = null;
    this.status = 'idle';
    this.requestId = 0;

    if (this.audio) {
      this.audio.addEventListener('timeupdate', () => {
        this.dispatchEvent(new CustomEvent('time', {
          detail: { current: this.audio.currentTime, duration: this.audio.duration || 0 },
        }));
      });
      this.audio.addEventListener('ended', () => {
        this.status = 'ended';
        this.dispatchEvent(new Event('ended'));
      });
      this.audio.addEventListener('play', () => {
        this.status = 'playing';
        this._emitStatus();
      });
      this.audio.addEventListener('pause', () => {
        if (this.audio.currentTime === 0 || this.audio.ended) return;
        this.status = 'paused';
        this._emitStatus();
      });
    }
  }

  _emitStatus(extra = {}) {
    this.dispatchEvent(new CustomEvent('status', {
      detail: {
        status: this.status,
        song: this.currentSong,
        ...extra,
      },
    }));
  }

  _setObjectUrl(url) {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = url;
    this.audio.src = url;
  }

  async play(song) {
    if (!this.audio || !song) return;
    this.requestId++;
    const rid = this.requestId;
    this.currentSong = song;
    this.status = 'buffering';
    this._emitStatus({ buffering: true });
    try {
      const buffer = await this.cache.get(song.url);
      if (rid !== this.requestId) return;
      const objectUrl = await dfpwmBufferToObjectUrl(buffer);
      if (rid !== this.requestId) return;
      this._setObjectUrl(objectUrl);
      await this.audio.play();
      this.status = 'playing';
      this._emitStatus();
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: song.title,
          artist: 'DFPWM Radio',
          album: 'Community playlist',
        });
        navigator.mediaSession.playbackState = 'playing';
      }
    } catch (err) {
      this.status = 'idle';
      this._emitStatus({ error: err });
      this.dispatchEvent(new CustomEvent('error', { detail: err }));
      throw err;
    }
  }

  pause() {
    if (!this.audio) return;
    this.audio.pause();
    this.status = 'paused';
    this._emitStatus();
  }

  resume() {
    if (!this.audio) return;
    this.audio.play().catch(() => {});
  }

  stop() {
    if (!this.audio) return;
    this.requestId++;
    this.audio.pause();
    this.audio.currentTime = 0;
    this.audio.removeAttribute('src');
    this.audio.load();
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.currentSong = null;
    this.status = 'idle';
    this._emitStatus();
  }
}

// ==============================
// UI
// ==============================
function cleanTitle(raw) {
  try {
    localStorage.setItem(APP_STATE_KEY, JSON.stringify(snapshot));
  } catch (err) {
    console.warn('Failed to persist state', err);
  }
};

function renderList(target, songsArr, listName) {
  target.innerHTML = '';
  songsArr.forEach((s, i) => {
    const div = document.createElement('div');
    div.className = 'song' + (selectedList === listName && i === selectedIndex ? ' active' : '');
    div.textContent = cleanTitle(s.title || s.url);
    div.onclick = () => {
      selectedList = listName;
      selectedIndex = i;
      renderLists();
    };
    target.appendChild(div);
  });
  if (ui.libraryCount) {
    ui.libraryCount.textContent = `${controllerState.filteredSongs.length} tracks loaded`;
  }
};

const renderDownloads = async () => {
  if (!ui.downloadsList) return;
  const cached = await cache.list();
  if (!cached.length) {
    const empty = document.createElement('p');
    empty.className = 'tag';
    empty.style.padding = '12px';
    empty.textContent = 'No cached tracks.';
    ui.downloadsList.innerHTML = '';
    ui.downloadsList.appendChild(empty);
    return;
  }
  const frag = document.createDocumentFragment();
  cached.forEach((url) => {
    const song = library.getByUrl(url) || { title: url.split('/').pop() || url };
    const row = document.createElement('div');
    row.className = 'item';

    const info = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'item-title';
    title.textContent = song.title;
    const meta = document.createElement('div');
    meta.className = 'tag';
    meta.textContent = 'Available offline';
    info.append(title, meta);

    const removeBtn = document.createElement('button');
    removeBtn.dataset.action = 'remove-cache';
    removeBtn.dataset.url = url;
    removeBtn.textContent = 'Remove';

function renderLists() {
  renderList(listPublicEl, publicSongs, 'public');
  renderList(listLocalEl, localSongs, 'local');
}

async function fetchSongs() {
  try {
    const res = await fetch(SONGS_JSON_URL);
    publicSongs = await res.json();
    selectedIndex = publicSongs.length > 0 ? 0 : -1;
    renderLists();
  } catch (e) {
    listPublicEl.innerHTML = `<div style="padding:12px;color:#a00">Failed to fetch songs: ${e.message}</div>`;
  }
};

const refreshCacheBadge = async (song = player.currentSong) => {
  if (!ui.nowCacheState || !song) return;
  const cached = await cache.has(song.url);
  ui.nowCacheState.textContent = cached ? 'Offline ready' : 'Streaming';
  ui.cacheToggleBtn && (ui.cacheToggleBtn.textContent = cached ? '✖ Remove from cache' : '⬇ Cache track');
};

const autoAdvance = async () => {
  const nextSong = queue.next(controllerState.repeatMode);
  if (nextSong) {
    await playSong(nextSong);
    renderQueue();
    return;
  }
  if (controllerState.shuffleAutoplay && controllerState.filteredSongs.length) {
    const random = controllerState.filteredSongs[Math.floor(Math.random() * controllerState.filteredSongs.length)];
    queue.enqueue(random);
    queue.currentIndex = queue.items.length - 1;
    renderQueue();
    await playSong(random);
    return;
  }
  setStatusText('Reached end of queue');
  persistState();
};

const handleQueueInteraction = async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const action = target.dataset.action;
  const index = Number(target.dataset.index);
  if (action === 'remove') {
    queue.remove(index);
    renderQueue();
    persistState();
  } else if (action === 'jump') {
    const song = queue.jump(index);
    renderQueue();
    persistState();
    await playSong(song);
  }
};

const handleLibraryInteraction = async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const url = target.dataset.url;
  const action = target.dataset.action;
  if (!url || !action) return;
  const song = library.getByUrl(url);
  if (!song) return;

  if (action === 'queue') {
    queue.enqueue(song);
    renderQueue();
    persistState();
    if (player.status === 'idle') await playSong(song);
  }
  if (action === 'cache') {
    setStatusText('Caching track…');
    await cache.put(song.url);
    setStatusText('Track cached');
    refreshCacheBadge(song);
    renderDownloads();
  }
};

// ==============================
// Bindings
// ==============================
volumeEl.oninput = () => {
  if (gainNode) gainNode.gain.value = parseFloat(volumeEl.value);
};
refreshBtn.onclick = fetchSongs;
playBtn.onclick = playSelected;
pauseBtn.onclick = pause;
stopBtn.onclick = stop;
removeBtn.onclick = () => {
  if (selectedIndex < 0) return;
  const list = selectedList === 'public' ? publicSongs : localSongs;
  list.splice(selectedIndex, 1);
  if (selectedIndex >= list.length) selectedIndex--;
  renderLists();
};

cacheBtn.onclick = async () => {
  if (selectedList !== 'public' || selectedIndex < 0) return;
  const song = publicSongs[selectedIndex];
  if (!localSongs.find(s => s.url === song.url)) localSongs.push(song);
  renderLists();
};

// ==============================
// Install Prompt
// ==============================
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredPrompt = event;
  if (ui.installBtn) ui.installBtn.style.display = 'inline-flex';
});
ui.installBtn && ui.installBtn.addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  ui.installBtn.style.display = 'none';
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW registration failed', err));
}

// ==============================
// Init
// ==============================
fetchSongs();
