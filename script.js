const SONGS_JSON_URL = 'https://pub-050fb801777b4853a0c36256d7ab9b36.r2.dev/songs.json';
const SAMPLE_RATE = 48000;
const LOCAL_STORAGE_KEY = 'dfpwm_local_songs';
const THEME_STORAGE_KEY = 'dfpwm_theme_seed';
const DEFAULT_THEME_SEED = '#0b0d10';
const SONG_CACHE_NAME = 'dfpwm-song-cache-v1';
const SW_CACHE_TIMEOUT_MS = 30000;

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

let publicSongs = [];
let localSongs = [];
let queueSongs = [];
let selectedList = 'public';
let selectedIndex = -1;
let songUidCounter = 1;

const byId = (...ids) => ids.map(id => document.getElementById(id)).find(Boolean) || null;

const listPublicEl = byId('list-public');
const listLocalEl = byId('list-local');
const listQueueEl = byId('list-queue');
const refreshBtn = byId('refreshBtn');
const playBtn = byId('playBtn');
const pauseBtn = byId('pauseBtn');
const stopBtn = byId('stopBtn');
const queueAddBtn = byId('queueAddBtn');
const removeBtn = byId('removeBtn');
const cacheBtn = byId('cacheBtn');
const clearQueueBtn = byId('clearQueueBtn');
const volumeEl = byId('volume');
const barEl = byId('bar');
const installBtn = byId('installBtn');
const nowPlayingTitleEl = byId('nowPlayingTitle', 'nowPlayingLabel');
const nowPlayingMetaEl = byId('nowPlayingMeta');
const statusTextEl = byId('statusText');
const statusBadgeEl = byId('statusBadge');
const statusSummaryEl = byId('statusSummary');
const elapsedEl = byId('elapsedTime');
const durationEl = byId('durationTime');
const countPublicEl = byId('count-public', 'publicCountLabel');
const countLocalEl = byId('count-local', 'localCountLabel');
const countQueueEl = byId('count-queue', 'queueCountLabel');
const publicListBadgeEl = byId('publicListBadge');
const localListBadgeEl = byId('localListBadge');
const queueListBadgeEl = byId('queueListBadge');
const themeColorPickerEl = byId('themeColorPicker', 'themeColorPickerEl');
const themeResetBtnEl = byId('themeResetBtn');
const themeSeedSwatchEl = byId('themeSeedSwatch', 'themeSeedSwatchEl');
const themeBaseSwatchEl = byId('themeBaseSwatch', 'themeBaseSwatchEl');
const themeAccentSwatchEl = byId('themeAccentSwatch', 'themeAccentSwatchEl');
const themeHintEl = byId('themeHint');
const metaThemeColorEl = document.querySelector('meta[name="theme-color"]');

let audioCtx = null;
let gainNode = null;
let currentSource = null;
let isPlaying = false;
let isPaused = false;
let startTime = 0;
let pauseOffset = 0;
let totalDuration = 0;
let currentSong = null;
let mediaSessionBound = false;
let playbackId = 0;
let currentFetchController = null;

function makeSongRecord(song) {
	const record = { ...(song || {}) };
	if (!record.url) return null;
	if (!record._id) {
		record._id = `song_${songUidCounter++}`;
	}
	return record;
}

function normalizeSongArray(input) {
	if (!Array.isArray(input)) return [];
	return input.map(makeSongRecord).filter(Boolean);
}

function formatTime(seconds) {
	if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
	const total = Math.floor(seconds);
	const mins = Math.floor(total / 60);
	const secs = total % 60;
	return `${mins}:${String(secs).padStart(2, '0')}`;
}


function clamp(value, min, max) {
	return Math.min(Math.max(value, min), max);
}

function normalizeHexColor(value) {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	const shortMatch = /^#([0-9a-f]{3})$/i.exec(trimmed);
	if (shortMatch) {
		return `#${shortMatch[1].split('').map(char => char + char).join('').toLowerCase()}`;
	}
	const longMatch = /^#([0-9a-f]{6})$/i.exec(trimmed);
	return longMatch ? `#${longMatch[1].toLowerCase()}` : null;
}

function hexToRgb(hex) {
	const normalized = normalizeHexColor(hex);
	if (!normalized) return null;
	const value = normalized.slice(1);
	return {
		r: parseInt(value.slice(0, 2), 16),
		g: parseInt(value.slice(2, 4), 16),
		b: parseInt(value.slice(4, 6), 16)
	};
}

function rgbToHex(r, g, b) {
	return `#${[r, g, b].map(channel => clamp(Math.round(channel), 0, 255).toString(16).padStart(2, '0')).join('')}`;
}

function rgbToRgbaString(rgb, alpha) {
	return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

function rgbToHsl(r, g, b) {
	const rn = r / 255;
	const gn = g / 255;
	const bn = b / 255;
	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	const lightness = (max + min) / 2;
	const delta = max - min;

	let hue = 0;
	let saturation = 0;

	if (delta !== 0) {
		saturation = delta / (1 - Math.abs(2 * lightness - 1));
		switch (max) {
			case rn:
				hue = 60 * (((gn - bn) / delta) % 6);
				break;
			case gn:
				hue = 60 * (((bn - rn) / delta) + 2);
				break;
			default:
				hue = 60 * (((rn - gn) / delta) + 4);
				break;
		}
	}

	if (hue < 0) hue += 360;
	return { h: hue, s: saturation * 100, l: lightness * 100 };
}

function hslToRgb(h, s, l) {
	const hue = ((h % 360) + 360) % 360;
	const sat = clamp(s, 0, 100) / 100;
	const light = clamp(l, 0, 100) / 100;
	const chroma = (1 - Math.abs(2 * light - 1)) * sat;
	const x = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
	const m = light - chroma / 2;

	let r1 = 0;
	let g1 = 0;
	let b1 = 0;

	if (hue < 60) {
		r1 = chroma; g1 = x;
	} else if (hue < 120) {
		r1 = x; g1 = chroma;
	} else if (hue < 180) {
		g1 = chroma; b1 = x;
	} else if (hue < 240) {
		g1 = x; b1 = chroma;
	} else if (hue < 300) {
		r1 = x; b1 = chroma;
	} else {
		r1 = chroma; b1 = x;
	}

	return {
		r: Math.round((r1 + m) * 255),
		g: Math.round((g1 + m) * 255),
		b: Math.round((b1 + m) * 255)
	};
}

function hslToHex(h, s, l) {
	const rgb = hslToRgb(h, s, l);
	return rgbToHex(rgb.r, rgb.g, rgb.b);
}
function buildThemePalette(seedHex) {
	const normalizedSeed = normalizeHexColor(seedHex) || DEFAULT_THEME_SEED;
	const seedRgb = hexToRgb(normalizedSeed) || hexToRgb(DEFAULT_THEME_SEED);
	const seedHsl = rgbToHsl(seedRgb.r, seedRgb.g, seedRgb.b);

	const hue = seedHsl.h;
	const sat = clamp(seedHsl.s || 36, 18, 90);
	const light = clamp(seedHsl.l || 40, 8, 82);
	const complementHue = (hue + 180) % 360;

	// True Background / User selection
	const backgroundHex = normalizedSeed;

	// Derive same-hue supporting shades from the selected colour
	const backgroundHex2 = hslToHex(hue, clamp(sat * 0.92, 16, 90), clamp(light - 8, 4, 78));
	const panelHex = hslToHex(hue, clamp(sat * 0.72, 12, 82), clamp(light - 14, 3, 72));
	const panelHex2 = hslToHex(hue, clamp(sat * 0.64, 10, 78), clamp(light - 20, 2, 66));
	const panelHex3 = hslToHex(hue, clamp(sat * 0.58, 10, 74), clamp(light - 26, 2, 60));

	// Text should contrast
	const textHex = light <= 42
		? hslToHex(hue, 14, 96)
		: hslToHex(hue, 18, 10);

	const mutedHex = light <= 42
		? hslToHex(hue, 10, 76)
		: hslToHex(hue, 10, 28);

	// Accent is the complementary colour.
	const accentHex = hslToHex(
		complementHue,
		clamp(Math.max(48, sat * 0.9), 36, 96),
		light <= 42 ? 58 : 42
	);

	const accentDarkHex = hslToHex(
		complementHue,
		clamp(Math.max(42, sat * 0.78), 30, 92),
		light <= 42 ? 46 : 32
	);

	const accentHoverHex = hslToHex(
		complementHue,
		clamp(Math.max(54, sat), 40, 98),
		light <= 42 ? 66 : 50
	);

	const accentHoverDarkHex = hslToHex(
		complementHue,
		clamp(Math.max(46, sat * 0.84), 34, 94),
		light <= 42 ? 52 : 38
	);

	const accentRgb = hexToRgb(accentHex);

	return {
		seedHex: normalizedSeed,
		backgroundHex,
		backgroundHex2,
		panelHex,
		panelHex2,
		panelHex3,
		textHex,
		mutedHex,
		accentHex,
		accentDarkHex,
		accentHoverHex,
		accentHoverDarkHex,
		accentSoft: rgbToRgbaString(accentRgb, 0.14),
		accentBorder: rgbToRgbaString(accentRgb, 0.22),
		ambient: rgbToRgbaString(accentRgb, 0.14),
		complementHex: accentHex
	};
}

function applyThemeSeed(seedHex, { persist = true } = {}) {
	const normalized = normalizeHexColor(seedHex) || DEFAULT_THEME_SEED;
	const palette = buildThemePalette(normalized);
	const rootStyle = document.documentElement.style;

	rootStyle.setProperty('--bg', palette.backgroundHex);
	rootStyle.setProperty('--bg-2', palette.backgroundHex2);
	rootStyle.setProperty('--panel', palette.panelHex);
	rootStyle.setProperty('--panel-2', palette.panelHex2);
	rootStyle.setProperty('--panel-3', palette.panelHex3);
	rootStyle.setProperty('--text', palette.textHex);
	rootStyle.setProperty('--muted', palette.mutedHex);
	rootStyle.setProperty('--accent', palette.accentHex);
	rootStyle.setProperty('--accent-2', palette.accentDarkHex);
	rootStyle.setProperty('--accent-hover', palette.accentHoverHex);
	rootStyle.setProperty('--accent-2-hover', palette.accentHoverDarkHex);
	rootStyle.setProperty('--accent-soft', palette.accentSoft);
	rootStyle.setProperty('--accent-border', palette.accentBorder);
	rootStyle.setProperty('--ambient', palette.ambient);

	if (themeColorPickerEl) themeColorPickerEl.value = normalized;
	if (themeSeedSwatchEl) themeSeedSwatchEl.style.background = normalized;
	if (themeBaseSwatchEl) themeBaseSwatchEl.style.background = palette.backgroundHex;
	if (themeAccentSwatchEl) themeAccentSwatchEl.style.background = palette.complementHex;

	if (themeHintEl) {
		themeHintEl.textContent =
			`Main ${palette.backgroundHex.toUpperCase()} · complement ${palette.complementHex.toUpperCase()}`;
	}

	if (metaThemeColorEl) {
		metaThemeColorEl.setAttribute('content', palette.backgroundHex);
	}

	if (persist) {
		localStorage.setItem(THEME_STORAGE_KEY, normalized);
	}
}

function loadSavedThemeSeed() {
	const stored = localStorage.getItem(THEME_STORAGE_KEY);
	return normalizeHexColor(stored) || DEFAULT_THEME_SEED;
}
function cleanTitle(raw) {
	try {
		const title = raw.split('/').pop().replace(/\.dfpwm$/i, '');
		return title.replace(/\(.*?\)|\[.*?\]/g, '').trim();
	} catch {
		return raw || 'Unknown title';
	}
}

function songDisplayTitle(song) {
	return cleanTitle(song?.title || song?.url || 'Unknown title');
}

function songDisplayMeta(song) {
	const parts = [];
	if (song?.artist) parts.push(song.artist);
	if (song?.album) parts.push(song.album);
	return parts.join(' • ') || 'DFPWM Stream';
}

function setStatus(message, tone = 'idle') {
	if (statusTextEl) statusTextEl.textContent = message;
	if (statusBadgeEl) {
		statusBadgeEl.dataset.tone = tone;
		statusBadgeEl.textContent = tone.charAt(0).toUpperCase() + tone.slice(1);
	}
	if (statusSummaryEl) statusSummaryEl.textContent = message;
}

function updateNowPlayingInfo(song = currentSong) {
	if (!song) {
		if (nowPlayingTitleEl) nowPlayingTitleEl.textContent = 'Nothing playing';
		if (nowPlayingMetaEl) nowPlayingMetaEl.textContent = 'Select a song, cache what you want offline, or queue a run.';
		if (elapsedEl) elapsedEl.textContent = '0:00';
		if (durationEl) durationEl.textContent = '0:00';
		return;
	}

	if (nowPlayingTitleEl) nowPlayingTitleEl.textContent = songDisplayTitle(song);
	if (nowPlayingMetaEl) nowPlayingMetaEl.textContent = songDisplayMeta(song);
	if (durationEl) durationEl.textContent = formatTime(totalDuration);
}

function updateCounters() {
	if (countPublicEl) countPublicEl.textContent = String(publicSongs.length);
	if (countLocalEl) countLocalEl.textContent = String(localSongs.length);
	if (countQueueEl) countQueueEl.textContent = String(queueSongs.length);
	if (publicListBadgeEl) publicListBadgeEl.textContent = String(publicSongs.length);
	if (localListBadgeEl) localListBadgeEl.textContent = String(localSongs.length);
	if (queueListBadgeEl) queueListBadgeEl.textContent = String(queueSongs.length);
}

function getListByName(name) {
	if (name === 'public') return publicSongs;
	if (name === 'local') return localSongs;
	if (name === 'queue') return queueSongs;
	return publicSongs;
}

function clampSelection() {
	const list = getListByName(selectedList);
	if (!list.length) {
		selectedIndex = -1;
		return;
	}
	if (selectedIndex < 0) selectedIndex = 0;
	if (selectedIndex >= list.length) selectedIndex = list.length - 1;
}

function getSelectedSong() {
	const list = getListByName(selectedList);
	if (!list.length || selectedIndex < 0 || selectedIndex >= list.length) return null;
	return list[selectedIndex];
}

function removeQueueSongById(songId) {
	const index = queueSongs.findIndex(song => song._id === songId);
	if (index < 0) return false;
	queueSongs.splice(index, 1);
	if (selectedList === 'queue') {
		if (!queueSongs.length) {
			selectedIndex = -1;
		} else if (selectedIndex > index) {
			selectedIndex -= 1;
		} else if (selectedIndex >= queueSongs.length) {
			selectedIndex = queueSongs.length - 1;
		}
	}
	return true;
}

function inferSongMetadata(url) {
	const fromPublic = publicSongs.find(song => song.url === url);
	if (fromPublic) return makeSongRecord(fromPublic);

	const fileName = (() => {
		try {
			const parsed = new URL(url);
			return parsed.pathname.split('/').pop() || url;
		} catch {
			return url;
		}
	})();

	return makeSongRecord({ url, title: cleanTitle(fileName) });
}

function isSongUrl(url) {
	try {
		return new URL(url).pathname.toLowerCase().endsWith('.dfpwm');
	} catch {
		return typeof url === 'string' && url.toLowerCase().endsWith('.dfpwm');
	}
}

function updateActionState() {
	const selectedSong = getSelectedSong();
	const canPlay = !!selectedSong;
	const canQueueAdd = !!selectedSong && selectedList !== 'queue';
	const canCache = selectedList === 'public' && !!selectedSong;
	const canRemoveLocal = selectedList === 'local' && !!selectedSong;
	const canRemoveQueue = selectedList === 'queue' && !!selectedSong;
	const canRemove = canRemoveLocal || canRemoveQueue;

	if (playBtn) playBtn.disabled = !canPlay;
	if (pauseBtn) pauseBtn.disabled = !isPlaying;
	if (stopBtn) stopBtn.disabled = !isPlaying && !isPaused;
	if (queueAddBtn) queueAddBtn.disabled = !canQueueAdd;
	if (cacheBtn) cacheBtn.disabled = !canCache;
	if (removeBtn) removeBtn.disabled = !canRemove;
	if (clearQueueBtn) clearQueueBtn.disabled = queueSongs.length === 0;

	if (selectedList === 'local') {
		if (removeBtn) removeBtn.textContent = 'Remove Local Copy';
	} else if (selectedList === 'queue') {
		if (removeBtn) removeBtn.textContent = 'Remove from Queue';
	} else {
		if (removeBtn) removeBtn.textContent = 'Remove';
	}

	if (pauseBtn) pauseBtn.textContent = isPaused ? 'Resume' : 'Pause';
}

function renderSongItem(song, index, listName) {
	const div = document.createElement('div');
	div.className = 'song' + (selectedList === listName && index === selectedIndex ? ' active' : '');
	div.draggable = true;

	const title = document.createElement('div');
	title.className = 'song-title';
	title.textContent = songDisplayTitle(song);

	const meta = document.createElement('div');
	meta.className = 'song-meta';
	meta.textContent = songDisplayMeta(song);

	div.append(title, meta);

	div.addEventListener('dragstart', event => {
		if (listName === 'queue') {
			event.dataTransfer.setData('text/queue-index', String(index));
			event.dataTransfer.effectAllowed = 'move';
		} else {
			event.dataTransfer.setData('text/song-url', song.url);
			event.dataTransfer.setData('text/song-source', listName);
			event.dataTransfer.effectAllowed = 'copy';
		}
	});

	div.addEventListener('click', () => {
		selectedList = listName;
		selectedIndex = index;
		renderLists();
	});

	div.addEventListener('dblclick', () => {
		selectedList = listName;
		selectedIndex = index;
		renderLists();
		playSelected();
	});

	return div;
}

function renderList(target, songsArr, listName, emptyMessage) {
	if (!target) return;
	target.innerHTML = '';
	if (!songsArr.length) {
		const empty = document.createElement('div');
		empty.className = 'empty-list';
		empty.textContent = emptyMessage;
		target.appendChild(empty);
		return;
	}

	songsArr.forEach((song, index) => {
		target.appendChild(renderSongItem(song, index, listName));
	});
}

function renderLists() {
	clampSelection();
	renderList(listPublicEl, publicSongs, 'public', 'No public songs available yet.');
	renderList(listLocalEl, localSongs, 'local', 'No cached songs yet. Cache something from Public Songs.');
	renderList(listQueueEl, queueSongs, 'queue', 'Queue is empty. Drag songs here or use Add to Queue.');
	updateCounters();
	updateActionState();
}

function ensureAudio() {
	if (!audioCtx) {
		audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
		gainNode = audioCtx.createGain();
		gainNode.gain.value = parseFloat(volumeEl?.value || '0.5');
		gainNode.connect(audioCtx.destination);
		audioCtx.onstatechange = () => {
			if (audioCtx.state === 'suspended' && isPlaying && !isPaused) {
				audioCtx.resume().catch(() => {});
			}
		};
	}

	if (audioCtx.state === 'suspended') {
		audioCtx.resume().catch(() => {});
	}
}

function clearMediaSessionState() {
	if (!('mediaSession' in navigator)) return;
	navigator.mediaSession.playbackState = 'none';
	try {
		navigator.mediaSession.metadata = null;
	} catch {
		// ignored
	}
}

function stop({ preserveCurrentSong = false } = {}) {
	playbackId += 1;

	if (currentFetchController) {
		currentFetchController.abort();
		currentFetchController = null;
	}

	if (currentSource) {
		try {
			currentSource.onended = null;
			currentSource.stop();
		} catch {
			// ignored
		}
		try {
			currentSource.disconnect();
		} catch {
			// ignored
		}
		currentSource = null;
	}

	isPlaying = false;
	isPaused = false;
	pauseOffset = 0;
	startTime = 0;
	totalDuration = 0;
	if (barEl) barEl.style.width = '0%';
	if (elapsedEl) elapsedEl.textContent = '0:00';
	if (durationEl) durationEl.textContent = '0:00';

	if (!preserveCurrentSong) {
		currentSong = null;
		updateNowPlayingInfo(null);
	}

	clearMediaSessionState();
	updateActionState();
}

async function togglePause() {
	if (!audioCtx || !isPlaying) return;
	if (!isPaused) {
		await audioCtx.suspend();
		isPaused = true;
		pauseOffset = audioCtx.currentTime - startTime;
		setMediaPlaybackState('paused', pauseOffset);
		setStatus(`Paused ${songDisplayTitle(currentSong)}`, 'paused');
	} else {
		await audioCtx.resume();
		isPaused = false;
		startTime = audioCtx.currentTime - pauseOffset;
		setMediaPlaybackState('playing', pauseOffset);
		setStatus(`Playing ${songDisplayTitle(currentSong)}`, 'playing');
	}
	updateActionState();
}

function setMediaMetadata(song) {
	if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined' || !song) return;
	navigator.mediaSession.metadata = new MediaMetadata({
		title: songDisplayTitle(song),
		artist: song.artist || 'DFPWM Stream',
		album: song.album || 'DFPWM Jukebox'
	});
}

function setMediaPlaybackState(state, position = 0) {
	if (!('mediaSession' in navigator)) return;
	navigator.mediaSession.playbackState = state;
	syncMediaPosition(position);
}

function syncMediaPosition(positionSeconds) {
	try {
		if (!('mediaSession' in navigator)) return;
		if (typeof navigator.mediaSession.setPositionState === 'function' && totalDuration > 0) {
			navigator.mediaSession.setPositionState({
				duration: totalDuration,
				playbackRate: 1,
				position: Math.max(0, Math.min(positionSeconds, totalDuration))
			});
		}
	} catch {
		// ignored
	}
}

function bindMediaControls() {
	if (!('mediaSession' in navigator) || mediaSessionBound) return;
	mediaSessionBound = true;

	navigator.mediaSession.setActionHandler('play', () => {
		if (isPlaying && isPaused) {
			togglePause();
			return;
		}
		if (currentSong && !isPlaying) {
			playSong(currentSong);
			return;
		}
		playSelected();
	});
	navigator.mediaSession.setActionHandler('pause', () => togglePause());
	navigator.mediaSession.setActionHandler('stop', () => stop());
	navigator.mediaSession.setActionHandler('previoustrack', () => skipTrack(-1));
	navigator.mediaSession.setActionHandler('nexttrack', () => skipTrack(1));
}

function updateProgress() {
	if (!isPlaying || !currentSource) return;
	const elapsed = isPaused ? pauseOffset : (audioCtx.currentTime - startTime);
	const pct = totalDuration > 0 ? Math.min(100 * (elapsed / totalDuration), 100) : 0;
	if (barEl) barEl.style.width = `${pct.toFixed(1)}%`;
	if (elapsedEl) elapsedEl.textContent = formatTime(elapsed);
	if (durationEl) durationEl.textContent = formatTime(totalDuration);
	syncMediaPosition(elapsed);
	requestAnimationFrame(updateProgress);
}

async function readResponseBodyAsDfpwmChunks(response, playId, controller) {
	const decoder = new DFPWM();
	const chunks = [];
	let totalSamples = 0;

	if (!response.body) {
		const bytes = new Uint8Array(await response.arrayBuffer());
		const pcm = decoder.decode(bytes);
		chunks.push(pcm);
		totalSamples += pcm.length;
		return { chunks, totalSamples };
	}

	const reader = response.body.getReader();

	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		if (playId !== playbackId) {
			try {
				controller.abort();
			} catch {
				// ignored
			}
			return { chunks: [], totalSamples: 0, aborted: true };
		}
		const pcm = decoder.decode(value);
		chunks.push(pcm);
		totalSamples += pcm.length;
	}

	return { chunks, totalSamples };
}

function playBuffered(chunks, totalSamples, song, playId, options = {}) {
	if (!audioCtx) throw new Error('Audio context is not ready.');
	if (!totalSamples) throw new Error('Song decoded to zero samples.');

	const audioBuffer = audioCtx.createBuffer(1, totalSamples, audioCtx.sampleRate);
	const data = audioBuffer.getChannelData(0);
	let offset = 0;
	for (const chunk of chunks) {
		data.set(chunk, offset);
		offset += chunk.length;
	}

	const src = audioCtx.createBufferSource();
	src.buffer = audioBuffer;
	src.connect(gainNode);
	src.start();

	currentSource = src;
	currentSong = song;
	totalDuration = audioBuffer.duration;
	startTime = audioCtx.currentTime;
	pauseOffset = 0;
	isPlaying = true;
	isPaused = false;

	if (options.dequeueQueueId) {
		removeQueueSongById(options.dequeueQueueId);
	}

	setMediaMetadata(song);
	setMediaPlaybackState('playing', 0);
	setStatus(`Playing ${songDisplayTitle(song)}`, 'playing');
	updateNowPlayingInfo(song);
	renderLists();

	src.onended = () => handleTrackEnd(playId);
	updateProgress();
}

async function playUrlStreamed(song, options = {}) {
	if (!song?.url) return;

	const playId = ++playbackId;
	currentSong = song;
	updateNowPlayingInfo(song);
	setStatus(`Loading ${songDisplayTitle(song)}…`, 'loading');

	if (currentFetchController) {
		currentFetchController.abort();
	}

	const controller = new AbortController();
	currentFetchController = controller;

	let response;
	try {
		response = await fetch(song.url, { cache: 'force-cache', signal: controller.signal });
	} catch (err) {
		if (currentFetchController === controller) currentFetchController = null;
		if (err?.name === 'AbortError' || playId !== playbackId) return;
		throw err;
	}

	if (!response?.ok) {
		if (currentFetchController === controller) currentFetchController = null;
		throw new Error(`HTTP ${response?.status || 'fetch failed'}`);
	}

	try {
		const decoded = await readResponseBodyAsDfpwmChunks(response, playId, controller);
		if (currentFetchController === controller) currentFetchController = null;
		if (decoded.aborted || playId !== playbackId) return;
		playBuffered(decoded.chunks, decoded.totalSamples, song, playId, options);
	} catch (err) {
		if (currentFetchController === controller) currentFetchController = null;
		if (err?.name === 'AbortError' || playId !== playbackId) return;
		throw err;
	}
}

async function playSong(song, options = {}) {
	if (!song) return;
	stop({ preserveCurrentSong: true });
	ensureAudio();
	try {
		await playUrlStreamed(song, options);
	} catch (err) {
		console.error('Playback failed', err);
		isPlaying = false;
		isPaused = false;
		currentSource = null;
		if (barEl) barEl.style.width = '0%';
		if (elapsedEl) elapsedEl.textContent = '0:00';
		totalDuration = 0;
		if (durationEl) durationEl.textContent = '0:00';
		setStatus(`Playback failed: ${err.message || 'Unknown error'}`, 'error');
		updateNowPlayingInfo(song);
		updateActionState();
	}
}

function playSelected() {
	const song = getSelectedSong();
	if (!song) return;
	const options = selectedList === 'queue' ? { dequeueQueueId: song._id } : {};
	playSong(song, options);
}

function playNextQueuedSong() {
	const nextSong = queueSongs[0];
	if (!nextSong) return;
	selectedList = 'queue';
	selectedIndex = 0;
	renderLists();
	playSong(nextSong, { dequeueQueueId: nextSong._id });
}

function handleTrackEnd(playId) {
	if (playId !== playbackId) return;
	isPlaying = false;
	isPaused = false;
	pauseOffset = 0;
	currentSource = null;
	if (barEl) barEl.style.width = '0%';
	if (elapsedEl) elapsedEl.textContent = '0:00';
	setMediaPlaybackState('none', totalDuration);
	if (queueSongs.length > 0) {
		setStatus('Track ended. Starting next queued song…', 'loading');
		playNextQueuedSong();
		return;
	}
	setStatus('Playback finished.', 'idle');
	updateActionState();
}

function skipTrack(delta) {
	if (delta > 0 && queueSongs.length > 0) {
		playNextQueuedSong();
		return;
	}

	const list = getListByName(selectedList);
	if (!list.length) return;
	selectedIndex = (selectedIndex + delta + list.length) % list.length;
	renderLists();
	playSelected();
}

function rememberSelection() {
	const song = getSelectedSong();
	return {
		listName: selectedList,
		url: song?.url || null
	};
}

function restoreSelection(snapshot) {
	if (!snapshot) return;
	const preferredList = getListByName(snapshot.listName);
	if (snapshot.url && preferredList.length) {
		const idx = preferredList.findIndex(song => song.url === snapshot.url);
		if (idx >= 0) {
			selectedList = snapshot.listName;
			selectedIndex = idx;
			return;
		}
	}

	if (getListByName(selectedList).length) {
		clampSelection();
		return;
	}

	if (publicSongs.length) {
		selectedList = 'public';
		selectedIndex = 0;
	} else if (localSongs.length) {
		selectedList = 'local';
		selectedIndex = 0;
	} else if (queueSongs.length) {
		selectedList = 'queue';
		selectedIndex = 0;
	} else {
		selectedIndex = -1;
	}
}

function saveLocalSongs() {
	localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(localSongs.map(song => {
		const clone = { ...song };
		delete clone._id;
		return clone;
	})));
}

function loadLocalSongs() {
	try {
		const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
		if (stored) {
			localSongs = normalizeSongArray(JSON.parse(stored));
		}
	} catch (err) {
		console.warn('Failed to load local songs', err);
		localSongs = [];
	}
}

async function syncLocalSongsWithCache() {
	if (!('caches' in window)) return false;
	try {
		const cache = await caches.open(SONG_CACHE_NAME);
		const requests = await cache.keys();
		const cachedUrls = requests.map(request => request.url).filter(isSongUrl);
		const cachedSet = new Set(cachedUrls);
		const existingMap = new Map(localSongs.map(song => [song.url, song]));
		const beforeLength = localSongs.length;

		localSongs = localSongs.filter(song => cachedSet.has(song.url));
		let changed = localSongs.length !== beforeLength;

		cachedUrls.forEach(url => {
			if (!localSongs.some(song => song.url === url)) {
				localSongs.push(existingMap.get(url) || inferSongMetadata(url));
				changed = true;
			}
		});

		localSongs = normalizeSongArray(localSongs);
		if (changed) saveLocalSongs();
		return changed;
	} catch (err) {
		console.warn('Failed to sync cached songs', err);
		return false;
	}
}

function hydrateLocalSongsFromPublic() {
	if (!publicSongs.length || !localSongs.length) return;
	const publicMap = new Map(publicSongs.map(song => [song.url, song]));
	let changed = false;

	localSongs = normalizeSongArray(localSongs.map(song => {
		const match = publicMap.get(song.url);
		if (!match) return song;
		const merged = { ...song, ...match, _id: song._id };
		if (!changed) {
			for (const key in merged) {
				if (merged[key] !== song[key]) {
					changed = true;
					break;
				}
			}
		}
		return merged;
	}));

	if (changed) saveLocalSongs();
}

async function fetchSongs() {
	const snapshot = rememberSelection();
	refreshBtn.disabled = true;
	setStatus('Refreshing public library…', 'loading');
	try {
		const response = await fetch(SONGS_JSON_URL, { cache: 'force-cache' });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		publicSongs = normalizeSongArray(await response.json());
		hydrateLocalSongsFromPublic();
		restoreSelection(snapshot);
		renderLists();
		setStatus(`Loaded ${publicSongs.length} public songs.`, 'idle');
	} catch (err) {
		console.error('Failed to fetch songs', err);
		setStatus(`Failed to fetch songs: ${err.message || 'Unknown error'}`, 'error');
		renderLists();
	} finally {
		refreshBtn.disabled = false;
	}
}

function getDropInsertIndex(container, clientY) {
	const rect = container.getBoundingClientRect();
	const y = clientY - rect.top + container.scrollTop;
	let index = 0;
	for (let i = 0; i < container.children.length; i++) {
		const child = container.children[i];
		if (child.classList.contains('empty-list')) continue;
		if (y > child.offsetTop + child.offsetHeight / 2) index = i + 1;
	}
	return index;
}

async function requestServiceWorkerAction(type, payload = {}) {
	if (!('serviceWorker' in navigator)) {
		throw new Error('Service worker is not supported in this browser.');
	}

	const registration = await navigator.serviceWorker.ready;
	const worker = navigator.serviceWorker.controller || registration.active || registration.waiting || registration.installing;
	if (!worker) {
		throw new Error('Service worker is not active yet. Reload once after install.');
	}

	return await new Promise((resolve, reject) => {
		const channel = new MessageChannel();
		const timeout = setTimeout(() => reject(new Error('Service worker request timed out.')), SW_CACHE_TIMEOUT_MS);

		channel.port1.onmessage = event => {
			clearTimeout(timeout);
			const data = event.data || {};
			if (data.ok) {
				resolve(data);
			} else {
				reject(new Error(data.error || 'Service worker request failed.'));
			}
		};

		worker.postMessage({ type, ...payload }, [channel.port2]);
	});
}

async function cacheSongAsset(song) {
	if (!song?.url) throw new Error('No song selected.');
	await requestServiceWorkerAction('CACHE_SONG_URL', { url: song.url });
}

async function removeSongFromCache(song) {
	if (!song?.url || !('caches' in window)) return;
	try {
		const cache = await caches.open(SONG_CACHE_NAME);
		await cache.delete(song.url);
	} catch (err) {
		console.warn('Failed to delete cached song', err);
	}
}

if (volumeEl) {
	volumeEl.addEventListener('input', () => {
		if (gainNode) gainNode.gain.value = parseFloat(volumeEl?.value || '0.5');
	});
}

if (themeColorPickerEl) {
	themeColorPickerEl.addEventListener('input', event => {
		applyThemeSeed(event.target.value);
	});
}

if (themeResetBtnEl) {
	themeResetBtnEl.addEventListener('click', () => {
		applyThemeSeed(DEFAULT_THEME_SEED);
		setStatus('Theme reset to default.', 'idle');
	});
}

if (refreshBtn) refreshBtn.addEventListener('click', fetchSongs);
if (playBtn) playBtn.addEventListener('click', () => playSelected());
if (pauseBtn) pauseBtn.addEventListener('click', () => togglePause());
if (stopBtn) stopBtn.addEventListener('click', () => {
	stop();
	setStatus('Playback stopped.', 'idle');
});
if (queueAddBtn) queueAddBtn.addEventListener('click', () => {
	const selectedSong = getSelectedSong();
	if (!selectedSong || selectedList === 'queue') return;
	queueSongs.push(makeSongRecord(selectedSong));
	selectedList = 'queue';
	selectedIndex = queueSongs.length - 1;
	renderLists();
	setStatus(`Queued ${songDisplayTitle(selectedSong)}.`, 'idle');
});

if (removeBtn) removeBtn.addEventListener('click', async () => {
	const list = getListByName(selectedList);
	if (!list.length || selectedIndex < 0 || selectedIndex >= list.length) return;

	const [removed] = list.splice(selectedIndex, 1);
	if (!removed) return;

	if (selectedList === 'local') {
		await removeSongFromCache(removed);
		saveLocalSongs();
		setStatus(`Removed cached copy of ${songDisplayTitle(removed)}.`, 'idle');
	} else if (selectedList === 'queue') {
		setStatus(`Removed ${songDisplayTitle(removed)} from queue.`, 'idle');
	}

	if (selectedIndex >= list.length) selectedIndex = list.length - 1;
	renderLists();
});

if (cacheBtn) cacheBtn.addEventListener('click', async () => {
	if (selectedList !== 'public' || selectedIndex < 0) return;
	const song = publicSongs[selectedIndex];
	cacheBtn.disabled = true;
	setStatus(`Caching ${songDisplayTitle(song)}…`, 'loading');
	try {
		await cacheSongAsset(song);
		await syncLocalSongsWithCache();
		renderLists();
		setStatus(`Cached ${songDisplayTitle(song)} for offline playback.`, 'idle');
	} catch (err) {
		console.error('Failed to cache song', err);
		setStatus(`Failed to cache song: ${err.message || 'Unknown error'}`, 'error');
	} finally {
		updateActionState();
	}
});

if (clearQueueBtn) clearQueueBtn.addEventListener('click', () => {
	queueSongs = [];
	if (selectedList === 'queue') selectedIndex = -1;
	renderLists();
	setStatus('Queue cleared.', 'idle');
});

let deferredPrompt = null;
if (installBtn) installBtn.hidden = true;
window.addEventListener('beforeinstallprompt', event => {
	event.preventDefault();
	deferredPrompt = event;
	if (installBtn) installBtn.hidden = false;
});

window.addEventListener('appinstalled', () => {
	deferredPrompt = null;
	if (installBtn) installBtn.hidden = true;
	setStatus('App installed.', 'idle');
});

if (installBtn) installBtn.addEventListener('click', async () => {
	if (!deferredPrompt) return;
	deferredPrompt.prompt();
	await deferredPrompt.userChoice;
	deferredPrompt = null;
	if (installBtn) installBtn.hidden = true;
});

if (listQueueEl) listQueueEl.addEventListener('dragover', event => {
	event.preventDefault();
	const movingIndex = event.dataTransfer.getData('text/queue-index');
	event.dataTransfer.dropEffect = movingIndex !== '' ? 'move' : 'copy';
});

if (listQueueEl) listQueueEl.addEventListener('drop', event => {
	event.preventDefault();

	const movingIndex = event.dataTransfer.getData('text/queue-index');
	if (movingIndex !== '') {
		const from = parseInt(movingIndex, 10);
		if (Number.isNaN(from) || from < 0 || from >= queueSongs.length) return;
		let to = getDropInsertIndex(listQueueEl, event.clientY);
		if (from < to) to -= 1;
		to = Math.max(0, Math.min(to, queueSongs.length - 1));
		const [item] = queueSongs.splice(from, 1);
		queueSongs.splice(to, 0, item);
		selectedList = 'queue';
		selectedIndex = to;
		renderLists();
		return;
	}

	const url = event.dataTransfer.getData('text/song-url');
	const source = event.dataTransfer.getData('text/song-source');
	if (!url) return;

	let song = null;
	if (source === 'public') song = publicSongs.find(entry => entry.url === url);
	else if (source === 'local') song = localSongs.find(entry => entry.url === url);
	if (!song) song = inferSongMetadata(url);

	const to = Math.max(0, Math.min(getDropInsertIndex(listQueueEl, event.clientY), queueSongs.length));
	queueSongs.splice(to, 0, makeSongRecord(song));
	selectedList = 'queue';
	selectedIndex = to;
	renderLists();
	setStatus(`Queued ${songDisplayTitle(song)}.`, 'idle');
});

document.addEventListener('visibilitychange', () => {
	if (!document.hidden && isPlaying) ensureAudio();
});

document.addEventListener('keydown', event => {
	if (event.target instanceof HTMLInputElement) return;
	if (event.code === 'Space') {
		event.preventDefault();
		if (isPlaying) {
			togglePause();
		} else {
			playSelected();
		}
	}
});

if ('serviceWorker' in navigator) {
	navigator.serviceWorker.register('./sw.js')
		.then(() => {
			setStatus('Ready.', 'idle');
		})
		.catch(err => {
			console.warn('Service worker registration failed', err);
			setStatus(`Offline support unavailable: ${err.message || 'Registration failed'}`, 'error');
		});
}

(async function init() {
	applyThemeSeed(loadSavedThemeSeed(), { persist: false });
	bindMediaControls();
	loadLocalSongs();
	updateNowPlayingInfo(null);
	renderLists();

	const updated = await syncLocalSongsWithCache();
	if (updated) renderLists();

	await fetchSongs();
})();
