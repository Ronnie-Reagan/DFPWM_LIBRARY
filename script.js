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

const dfpwmBufferToFloat32 = (arrayBuffer) => {
  const decoder = new DFPWM();
  return decoder.decode(new Uint8Array(arrayBuffer));
};

const float32ToWavBuffer = (samples, sampleRate) => {
  const dataLength = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataLength, true);

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

  persist() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.songs));
    } catch (err) {
      console.warn('Failed to persist library', err);
    }
  }

  async refresh() {
    const res = await fetch(SONGS_JSON_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    this.setSongs(data);
    this.persist();
    return this.songs;
  }

  getByUrl(url) {
    return this.songs.find((song) => song.url === url) || null;
  }
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

// =============================================
// UI + Controller state
// =============================================
const ui = {
  nowTitle: document.getElementById('nowTitle'),
  nowStatus: document.getElementById('nowStatus'),
  nowCacheState: document.getElementById('nowCacheState'),
  progressFill: document.getElementById('progressFill'),
  elapsed: document.getElementById('elapsed'),
  duration: document.getElementById('duration'),
  volume: document.getElementById('volume'),
  playPauseBtn: document.getElementById('playPauseBtn'),
  stopBtn: document.getElementById('stopBtn'),
  prevBtn: document.getElementById('prevBtn'),
  nextBtn: document.getElementById('nextBtn'),
  shuffleBtn: document.getElementById('shuffleBtn'),
  repeatBtn: document.getElementById('repeatBtn'),
  clearQueueBtn: document.getElementById('clearQueueBtn'),
  cacheToggleBtn: document.getElementById('cacheToggleBtn'),
  queueList: document.getElementById('queueList'),
  queueSummary: document.getElementById('queueSummary'),
  shuffleQueueBtn: document.getElementById('shuffleQueueBtn'),
  libraryCount: document.getElementById('libraryCount'),
  libraryList: document.getElementById('libraryList'),
  filterInput: document.getElementById('filterInput'),
  refreshBtn: document.getElementById('refreshBtn'),
  queueAllBtn: document.getElementById('queueAllBtn'),
  downloadsList: document.getElementById('downloadsList'),
  downloadAllBtn: document.getElementById('downloadAllBtn'),
  purgeCacheBtn: document.getElementById('purgeCacheBtn'),
  installBtn: document.getElementById('installBtn'),
  legacyBtn: document.getElementById('legacyBtn'),
  popoutBtn: document.getElementById('popoutBtn'),
};

const library = new SongLibrary(LIBRARY_STORAGE_KEY);
const cache = new SongCache(SONG_CACHE_NAME);
const queue = new PlaybackQueue();
const player = new PlayerEngine(audioEl, cache);

const controllerState = {
  filteredSongs: [],
  repeatMode: 'off',
  shuffleAutoplay: false,
  downloading: false,
};

const setStatusText = (text) => { if (ui.nowStatus) ui.nowStatus.textContent = text; };
const setNowTitle = (text) => { if (ui.nowTitle) ui.nowTitle.textContent = text; };

const updateProgress = (current, total) => {
  if (ui.elapsed) ui.elapsed.textContent = formatTime(current);
  if (ui.duration) ui.duration.textContent = formatTime(total);
  if (ui.progressFill) {
    const pct = total ? (current / total) * 100 : 0;
    ui.progressFill.style.width = `${pct}%`;
  }
};

const updateRepeatButton = () => {
  if (!ui.repeatBtn) return;
  const label = controllerState.repeatMode === 'off' ? 'Off' : controllerState.repeatMode === 'track' ? 'Track' : 'Queue';
  ui.repeatBtn.textContent = `🔁 Repeat: ${label}`;
};

const updateShuffleButton = () => {
  if (!ui.shuffleBtn) return;
  ui.shuffleBtn.textContent = controllerState.shuffleAutoplay ? '🔀 Shuffle: On' : '🔀 Shuffle: Off';
};

const persistState = (extra = {}) => {
  const snapshot = {
    repeatMode: controllerState.repeatMode,
    shuffleAutoplay: controllerState.shuffleAutoplay,
    queue: queue.serialize(),
    timestamp: Date.now(),
    ...extra,
  };
  try {
    localStorage.setItem(APP_STATE_KEY, JSON.stringify(snapshot));
  } catch (err) {
    console.warn('Failed to persist state', err);
  }
};

const restoreState = () => {
  const raw = localStorage.getItem(APP_STATE_KEY);
  if (!raw) return;
  try {
    const snapshot = JSON.parse(raw);
    if (snapshot.queue) queue.load(snapshot.queue);
    if (snapshot.repeatMode) controllerState.repeatMode = snapshot.repeatMode;
    if (typeof snapshot.shuffleAutoplay === 'boolean') controllerState.shuffleAutoplay = snapshot.shuffleAutoplay;
    updateRepeatButton();
    updateShuffleButton();
    renderQueue();
  } catch (err) {
    console.warn('Failed to restore state', err);
  }
};

const renderQueue = () => {
  if (!ui.queueList) return;
  ui.queueList.innerHTML = '';
  if (!queue.size()) {
    const empty = document.createElement('p');
    empty.className = 'tag';
    empty.style.padding = '12px';
    empty.textContent = 'Queue empty. Add tracks from the library.';
    ui.queueList.appendChild(empty);
  } else {
    queue.items.forEach((song, index) => {
      const row = document.createElement('div');
      row.className = `item${index === queue.currentIndex ? ' active' : ''}`;
      row.dataset.index = String(index);

      const info = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'item-title';
      title.textContent = song.title;
      const meta = document.createElement('div');
      meta.className = 'tag';
      meta.textContent = `${index === queue.currentIndex ? 'Now' : 'Queued'} · ${song.rawTitle || ''}`;
      info.append(title, meta);

      const actions = document.createElement('div');
      actions.style.display = 'flex';
      actions.style.gap = '6px';
      const playBtn = document.createElement('button');
      playBtn.dataset.action = 'jump';
      playBtn.dataset.index = String(index);
      playBtn.textContent = 'Play';
      const removeBtn = document.createElement('button');
      removeBtn.dataset.action = 'remove';
      removeBtn.dataset.index = String(index);
      removeBtn.textContent = '✕';
      actions.append(playBtn, removeBtn);

      row.append(info, actions);
      ui.queueList.appendChild(row);
    });
  }
  if (ui.queueSummary) {
    ui.queueSummary.textContent = queue.size() ? `${queue.size()} tracks` : 'Queue empty';
  }
};

const renderLibrary = () => {
  if (!ui.libraryList) return;
  ui.libraryList.innerHTML = '';
  if (!controllerState.filteredSongs.length) {
    const empty = document.createElement('p');
    empty.className = 'tag';
    empty.style.padding = '12px';
    empty.textContent = 'No matches.';
    ui.libraryList.appendChild(empty);
    return;
  }
  controllerState.filteredSongs.forEach((song) => {
    const row = document.createElement('div');
    row.className = 'item';
    row.dataset.url = song.url;

    const info = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'item-title';
    title.textContent = song.title;
    const meta = document.createElement('div');
    meta.className = 'tag';
    meta.textContent = song.rawTitle || '';
    info.append(title, meta);

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '6px';
    const queueBtn = document.createElement('button');
    queueBtn.dataset.action = 'queue';
    queueBtn.dataset.url = song.url;
    queueBtn.textContent = 'Queue';
    const cacheBtn = document.createElement('button');
    cacheBtn.dataset.action = 'cache';
    cacheBtn.dataset.url = song.url;
    cacheBtn.textContent = 'Cache';
    actions.append(queueBtn, cacheBtn);

    row.append(info, actions);
    ui.libraryList.appendChild(row);
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

    row.append(info, removeBtn);
    frag.appendChild(row);
  });
  ui.downloadsList.innerHTML = '';
  ui.downloadsList.appendChild(frag);
};

const filterLibrary = () => {
  const query = (ui.filterInput?.value || '').toLowerCase();
  controllerState.filteredSongs = !query
    ? library.songs.slice()
    : library.songs.filter((song) => song.title.toLowerCase().includes(query));
  renderLibrary();
};

const playSong = async (song) => {
  if (!song) {
    setStatusText('Idle');
    setNowTitle('Nothing queued');
    updateProgress(0, 0);
    return;
  }
  setNowTitle(song.title);
  setStatusText('Buffering…');
  try {
    await player.play(song);
    persistState();
    refreshCacheBadge(song);
  } catch (err) {
    setStatusText('Playback failed');
    console.error(err);
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

const bootstrapLibrary = async () => {
  library.loadFromStorage();
  controllerState.filteredSongs = library.songs.slice();
  renderLibrary();
  try {
    await library.refresh();
    controllerState.filteredSongs = library.songs.slice();
    renderLibrary();
    setStatusText('Library refreshed');
  } catch (err) {
    console.error(err);
    setStatusText('Offline library in use');
  }
};

const cacheEverything = async () => {
  if (controllerState.downloading) return;
  controllerState.downloading = true;
  setStatusText('Caching full library…');
  for (const song of library.songs) {
    try {
      await cache.put(song.url);
    } catch (err) {
      console.warn('Failed to cache', song.url, err);
    }
  }
  controllerState.downloading = false;
  setStatusText('Library cached');
  renderDownloads();
};

const removeCached = async (url) => {
  await cache.remove(url);
  renderDownloads();
  if (player.currentSong && player.currentSong.url === url) refreshCacheBadge(player.currentSong);
};

const initEventListeners = () => {
  ui.volume && (ui.volume.addEventListener('input', () => {
    if (audioEl) audioEl.volume = parseFloat(ui.volume.value);
  }));

  ui.playPauseBtn && ui.playPauseBtn.addEventListener('click', async () => {
    if (player.status === 'playing') {
      player.pause();
      setStatusText('Paused');
      ui.playPauseBtn.textContent = '▶ Resume';
    } else if (player.status === 'paused') {
      player.resume();
      setStatusText('Playing');
      ui.playPauseBtn.textContent = '⏸ Pause';
    } else {
      const song = queue.getCurrent() || queue.items[0];
      if (song) {
        await playSong(song);
        ui.playPauseBtn.textContent = '⏸ Pause';
      }
    }
  });

  ui.stopBtn && ui.stopBtn.addEventListener('click', () => {
    player.stop();
    updateProgress(0, 0);
    setStatusText('Stopped');
    ui.playPauseBtn && (ui.playPauseBtn.textContent = '▶ Play');
  });

  ui.nextBtn && ui.nextBtn.addEventListener('click', () => {
    const nextSong = queue.next(controllerState.repeatMode);
    if (nextSong) {
      playSong(nextSong);
      renderQueue();
      return;
    }
    if (controllerState.shuffleAutoplay && controllerState.filteredSongs.length) {
      const random = controllerState.filteredSongs[Math.floor(Math.random() * controllerState.filteredSongs.length)];
      queue.enqueue(random);
      queue.currentIndex = queue.items.length - 1;
      renderQueue();
      playSong(random);
      return;
    }
    setStatusText('Nothing to skip to');
  });

  ui.prevBtn && ui.prevBtn.addEventListener('click', () => {
    const song = queue.previous(controllerState.repeatMode);
    if (song) playSong(song);
    renderQueue();
  });

  ui.shuffleBtn && ui.shuffleBtn.addEventListener('click', () => {
    controllerState.shuffleAutoplay = !controllerState.shuffleAutoplay;
    updateShuffleButton();
    persistState();
  });

  ui.repeatBtn && ui.repeatBtn.addEventListener('click', () => {
    controllerState.repeatMode = controllerState.repeatMode === 'off' ? 'track' : controllerState.repeatMode === 'track' ? 'queue' : 'off';
    updateRepeatButton();
    persistState();
  });

  ui.clearQueueBtn && ui.clearQueueBtn.addEventListener('click', () => {
    queue.clear();
    player.stop();
    updateProgress(0, 0);
    setNowTitle('Nothing queued');
    renderQueue();
    persistState();
  });

  ui.cacheToggleBtn && ui.cacheToggleBtn.addEventListener('click', async () => {
    const song = player.currentSong || queue.getCurrent();
    if (!song) return;
    const cached = await cache.has(song.url);
    if (cached) {
      await cache.remove(song.url);
    } else {
      await cache.put(song.url);
    }
    refreshCacheBadge(song);
    renderDownloads();
  });

  ui.queueList && ui.queueList.addEventListener('click', (event) => {
    event.preventDefault();
    handleQueueInteraction(event);
  });

  ui.shuffleQueueBtn && ui.shuffleQueueBtn.addEventListener('click', () => {
    queue.shuffle();
    renderQueue();
    persistState();
  });

  ui.libraryList && ui.libraryList.addEventListener('click', (event) => {
    event.preventDefault();
    handleLibraryInteraction(event);
  });

  ui.filterInput && ui.filterInput.addEventListener('input', () => {
    filterLibrary();
  });

  ui.refreshBtn && ui.refreshBtn.addEventListener('click', async () => {
    setStatusText('Refreshing…');
    try {
      await library.refresh();
      controllerState.filteredSongs = library.songs.slice();
      renderLibrary();
      setStatusText('Library refreshed');
    } catch (err) {
      setStatusText('Refresh failed');
    }
  });

  ui.queueAllBtn && ui.queueAllBtn.addEventListener('click', async () => {
    queue.enqueueMany(controllerState.filteredSongs);
    renderQueue();
    persistState();
    if (!player.currentSong) {
      const song = queue.getCurrent();
      if (song) await playSong(song);
    }
  });

  ui.downloadAllBtn && ui.downloadAllBtn.addEventListener('click', cacheEverything);
  ui.purgeCacheBtn && ui.purgeCacheBtn.addEventListener('click', async () => {
    await cache.clear();
    renderDownloads();
    refreshCacheBadge(player.currentSong || queue.getCurrent());
  });

  ui.downloadsList && ui.downloadsList.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.dataset.action === 'remove-cache') {
      removeCached(target.dataset.url);
    }
  });

  ui.legacyBtn && ui.legacyBtn.addEventListener('click', () => {
    window.open('legacy.html', '_blank');
  });

  ui.popoutBtn && ui.popoutBtn.addEventListener('click', () => {
    window.open('popout.html', 'dfpwm-popout', 'width=420,height=640');
  });

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('previoustrack', () => ui.prevBtn?.click());
      navigator.mediaSession.setActionHandler('nexttrack', () => ui.nextBtn?.click());
      navigator.mediaSession.setActionHandler('play', () => {
        if (player.status === 'paused') {
          player.resume();
        } else {
          const song = queue.getCurrent();
          if (song) playSong(song);
        }
      });
      navigator.mediaSession.setActionHandler('pause', () => player.pause());
    } catch (err) {
      console.warn('MediaSession unsupported', err);
    }
  }

  window.addEventListener('storage', (event) => {
    if (event.key === APP_STATE_KEY) {
      restoreState();
    }
  });

  player.addEventListener('time', (event) => {
    const { current, duration } = event.detail;
    updateProgress(current, duration);
  });

  player.addEventListener('ended', () => {
    autoAdvance();
  });

  player.addEventListener('status', (event) => {
    const { status } = event.detail;
    if (!ui.playPauseBtn) return;
    if (status === 'playing') {
      ui.playPauseBtn.textContent = '⏸ Pause';
      setStatusText('Playing');
    } else if (status === 'paused') {
      ui.playPauseBtn.textContent = '▶ Resume';
      setStatusText('Paused');
    } else if (status === 'buffering') {
      ui.playPauseBtn.textContent = '…';
      setStatusText('Buffering…');
    } else if (status === 'idle') {
      ui.playPauseBtn.textContent = '▶ Play';
      setStatusText('Idle');
    }
  });
};

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

const init = async () => {
  restoreState();
  initEventListeners();
  filterLibrary();
  await bootstrapLibrary();
  filterLibrary();
  renderQueue();
  renderDownloads();
  if (ui.volume && audioEl) audioEl.volume = parseFloat(ui.volume.value);
};

if (audioEl) {
  init();
}
