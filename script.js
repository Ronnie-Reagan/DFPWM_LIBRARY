// ==============================
// Configuration
// ==============================
const SONGS_JSON_URL = 'https://pub-050fb801777b4853a0c36256d7ab9b36.r2.dev/songs.json';
const SAMPLE_RATE = 48000;
const LOCAL_STORAGE_KEY = 'dfpwm_local_songs';
const SONG_CACHE_NAME = 'dfpwm-song-cache-v1';

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
let queueSongs = [];
let selectedList = 'public';
let selectedIndex = -1;

const listPublicEl = document.getElementById('list-public');
const listLocalEl = document.getElementById('list-local');
const refreshBtn = document.getElementById('refreshBtn');
const playBtn = document.getElementById('playBtn');
const pauseBtn = document.getElementById('pauseBtn');
const stopBtn = document.getElementById('stopBtn');
const queueAddBtn = document.getElementById('queueAddBtn');
const removeBtn = document.getElementById('removeBtn');
const cacheBtn = document.getElementById('cacheBtn');
const volumeEl = document.getElementById('volume');
const barEl = document.getElementById('bar');
const installBtn = document.getElementById('installBtn');
const listQueueEl = document.getElementById("list-queue");

let audioCtx = null;
let gainNode = null;
let currentSource = null;
let isPlaying = false;
let isPaused = false;
let startTime = 0;
let pauseOffset = 0;
let totalDuration = 0;
let mediaStreamDest = null;
let mediaElement = null;
let currentSong = null;
let mediaSessionBound = false;
let playbackId = 0;
let currentFetchController = null;

// ==============================
// Audio Control
// ==============================
function ensureAudio() {
	if (!audioCtx) {
		audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
		gainNode = audioCtx.createGain();
		gainNode.gain.value = parseFloat(volumeEl.value);

		// Route audio through a hidden media element so mobile browsers
		// keep playback alive when the tab/app is backgrounded.
		const canStreamToElement = !!(audioCtx.createMediaStreamDestination && 'srcObject' in new Audio());
		if (canStreamToElement) {
			mediaStreamDest = audioCtx.createMediaStreamDestination();
			gainNode.connect(mediaStreamDest);

			mediaElement = new Audio();
			mediaElement.srcObject = mediaStreamDest.stream;
			mediaElement.playsInline = true;
			mediaElement.autoplay = true;
			mediaElement.muted = false;
			mediaElement.play().catch(() => { });
		} else {
			gainNode.connect(audioCtx.destination);
		}

		audioCtx.onstatechange = () => {
			if (audioCtx.state === 'suspended' && isPlaying) {
				audioCtx.resume().catch(() => { });
			}
		};
	}
	if (audioCtx.state === "suspended") audioCtx.resume().catch(() => { });
	if (mediaElement && mediaElement.paused) {
		mediaElement.play().catch(() => { });
	}
}

function stop() {
	playbackId++;

	if (currentFetchController) {
		currentFetchController.abort();
		currentFetchController = null;
	}

	if (currentSource) {
		try { currentSource.onended = null; currentSource.stop(); } catch { }
		currentSource.disconnect();
		currentSource = null;
	}
	isPlaying = false;
	isPaused = false;
	pauseOffset = 0;
	currentSong = null;
	if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
	barEl.style.width = '0%';
}

function pause() {
	if (!isPlaying) return;
	if (!isPaused) {
		audioCtx.suspend();
		isPaused = true;
		pauseOffset = audioCtx.currentTime - startTime;
		setMediaPlaybackState('paused', pauseOffset);
	} else {
		audioCtx.resume();
		isPaused = false;
		startTime = audioCtx.currentTime - pauseOffset;
		setMediaPlaybackState('playing', pauseOffset);
	}
}

function getListByName(name) {
	if (name === 'public') return publicSongs;
	if (name === 'local') return localSongs;
	if (name === 'queue') return queueSongs;
	return publicSongs;
}

function takeSelectedSong() {
	const list = getListByName(selectedList);
	if (!list.length || selectedIndex < 0 || selectedIndex >= list.length) return null;

	// When playing from queue, dequeue that entry so it can't replay.
	if (selectedList === 'queue') {
		const [song] = list.splice(selectedIndex, 1);
		if (selectedIndex >= list.length) selectedIndex = list.length - 1;
		renderQueue();
		return song;
	}

	return list[selectedIndex];
}

// ==============================
// Playback
// ==============================
async function playSelected() {
	const song = takeSelectedSong();
	if (!song) return;
	stop();
	ensureAudio();
	await playUrlStreamed(song);
}

async function playUrlStreamed(song) {
	if (!song?.url) return;

	const playId = ++playbackId;
	currentSong = song || null;

	if (currentFetchController) {
		currentFetchController.abort();
	}

	const controller = new AbortController();
	currentFetchController = controller;

	// Important for offline: force the browser to try cache first.
	let res;
	try {
		res = await fetch(song.url, { cache: "force-cache", signal: controller.signal });
	} catch (err) {
		if (currentFetchController === controller) currentFetchController = null;
		if (err.name === 'AbortError' || playId !== playbackId) return;
		throw err;
	}
	if (!res?.ok) {
		if (currentFetchController === controller) currentFetchController = null;
		throw new Error('HTTP ' + (res?.status || 'fetch failed'));
	}

	const reader = res.body.getReader();
	const decoder = new DFPWM();
	const chunks = [];
	let totalSamples = 0;

	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			const pcm = decoder.decode(value);
			chunks.push(pcm);
			totalSamples += pcm.length;

			// If a new playback started or stop() was called, abort decoding early.
			if (playId !== playbackId) {
				try { controller.abort(); } catch { }
				if (currentFetchController === controller) currentFetchController = null;
				return;
			}
		}
	} catch (err) {
		if (err.name === 'AbortError' || playId !== playbackId) return;
		throw err;
	} finally {
		if (currentFetchController === controller) {
			currentFetchController = null;
		}
	}

	if (playId !== playbackId) return;
	playBuffered(chunks, totalSamples, song, playId);
}

function playBuffered(chunks, totalSamples, song, playId = ++playbackId) {
	if (!totalSamples) {
		handleTrackEnd(playId);
		return;
	}

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
	pauseOffset = 0;
	currentSource = src;
	isPlaying = true;
	isPaused = false;
	currentSong = song || null;
	setMediaMetadata(song);
	setMediaPlaybackState('playing', 0);

	src.onended = () => handleTrackEnd(playId);



	updateProgress();
}

async function playNextFromQueue() {
	if (!queueSongs.length) {
		return;
	}

	selectedList = 'queue';
	selectedIndex = 0;
	const next = queueSongs.shift();
	renderLists();

	try {
		ensureAudio();
		await playUrlStreamed(next);
	} catch (err) {
		if (err?.name === 'AbortError') return;
		console.error('Failed to play queued song', err);
		// Move on to the next item if available
		if (queueSongs.length) playNextFromQueue();
	}
}

function handleTrackEnd(playId) {
	if (playId !== playbackId) return;

	isPlaying = false;
	isPaused = false;
	pauseOffset = 0;
	currentSource = null;
	barEl.style.width = '0%';
	setMediaPlaybackState('none', totalDuration);

	if (queueSongs.length > 0) {
		playNextFromQueue();
	}
}

function updateProgress() {
	if (!isPlaying) return;
	const elapsed = isPaused ? pauseOffset : (audioCtx.currentTime - startTime);
	if (!isPaused) {
		const pct = Math.min(100 * (elapsed / totalDuration), 100);
		barEl.style.width = pct.toFixed(1) + '%';
	}
	syncMediaPosition(elapsed);
	requestAnimationFrame(updateProgress);
}

function setMediaMetadata(song) {
	if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined' || !song) return;
	const title = song.title || cleanTitle(song.url);
	navigator.mediaSession.metadata = new MediaMetadata({
		title,
		artist: song.artist || 'DFPWM Stream',
		album: 'DFPWM Jukebox',
		artwork: [{ src: 'icon.png', sizes: '512x512', type: 'image/png' }]
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

		if (typeof navigator.mediaSession.setPositionState === 'function' && totalDuration) {
			navigator.mediaSession.setPositionState({
				duration: totalDuration,
				playbackRate: 1,
				position: Math.max(0, Math.min(positionSeconds, totalDuration))
			});
		}
	} catch (err) {
		console.warn("mediaSession.setPositionState failed:", err);
	}
}

function bindMediaControls() {
	if (!('mediaSession' in navigator) || mediaSessionBound) return;
	mediaSessionBound = true;

	navigator.mediaSession.setActionHandler('play', () => {
		if (isPlaying && isPaused) {
			pause(); // resume
		} else {
			playSelected();
		}
	});
	navigator.mediaSession.setActionHandler('pause', () => pause());
	navigator.mediaSession.setActionHandler('stop', () => stop());
	navigator.mediaSession.setActionHandler('previoustrack', () => skipTrack(-1));
	navigator.mediaSession.setActionHandler('nexttrack', () => skipTrack(1));
}

function skipTrack(delta) {
	// If we have an upcoming queue and user hit "next", consume queue first.
	if (delta > 0 && queueSongs.length) {
		stop();
		playNextFromQueue();
		return;
	}

	const list = getListByName(selectedList);
	if (!list.length) return;

	selectedIndex = (selectedIndex + delta + list.length) % list.length;
	renderLists();
	playSelected();
}

document.addEventListener('visibilitychange', () => {
	if (!document.hidden && isPlaying) ensureAudio();
});

// ==============================
// UI
// ==============================
function cleanTitle(raw) {
	try {
		let title = raw.split('/').pop().replace(/\.dfpwm$/i, '');
		return title.replace(/\(.*?\)|\[.*?\]/g, '').trim();
	} catch { return raw; }
}

function renderList(target, songsArr, listName) {
	target.innerHTML = '';
	songsArr.forEach((s, i) => {
		const div = document.createElement('div');
		div.className = 'song' + (selectedList === listName && i === selectedIndex ? ' active' : '');
		div.textContent = cleanTitle(s.title || s.url);

		// ENABLE DRAG
		div.draggable = true;
		div.addEventListener('dragstart', e => {
			e.dataTransfer.setData('text/song-url', s.url);
			e.dataTransfer.setData('text/song-source', listName);
			e.dataTransfer.effectAllowed = 'copy';
		});

		div.onclick = () => {
			selectedList = listName;
			selectedIndex = i;
			renderLists();
		};

		target.appendChild(div);
	});
}


function renderQueue() {
	listQueueEl.innerHTML = '';

	queueSongs.forEach((s, i) => {
		const div = document.createElement('div');
		div.className = 'song' + (selectedList === 'queue' && i === selectedIndex ? ' active' : '');
		div.textContent = cleanTitle(s.title || s.url);
		div.draggable = true;

		// Optional: allow reordering if you want later
		div.addEventListener('dragstart', e => {
			e.dataTransfer.setData('text/queue-index', i);
			e.dataTransfer.effectAllowed = 'move';
		});

		div.onclick = () => {
			selectedList = 'queue';
			selectedIndex = i;
			renderLists();
		};

		listQueueEl.appendChild(div);
	});
}

function renderLists() {
	clampSelection();
	renderList(listPublicEl, publicSongs, 'public');
	renderList(listLocalEl, localSongs, 'local');
	renderQueue();
}

async function fetchSongs() {
	try {
		const res = await fetch(SONGS_JSON_URL, { cache: "force-cache" });
		publicSongs = await res.json();
		hydrateLocalSongsFromPublic();
		selectedIndex = publicSongs.length > 0 ? 0 : -1;
		renderLists();
	} catch (e) {
		listPublicEl.innerHTML = `<div style="padding:12px;color:#a00">Failed to fetch songs: ${e.message}</div>`;
	}
}

function saveLocalSongs() {
	localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(localSongs));
}

function loadLocalSongs() {
	try {
		const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
		if (stored) localSongs = JSON.parse(stored);
	} catch (e) {
		console.warn('Failed to load local songs', e);
	}
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

function isSongUrl(url) {
	try {
		return new URL(url).pathname.toLowerCase().endsWith('.dfpwm');
	} catch {
		return typeof url === 'string' && url.toLowerCase().endsWith('.dfpwm');
	}
}

function inferSongMetadata(url) {
	const fromPublic = publicSongs.find(s => s.url === url);
	if (fromPublic) return { ...fromPublic };
	const fileName = (() => {
		try {
			const parsed = new URL(url);
			return parsed.pathname.split('/').pop() || url;
		} catch {
			return url;
		}
	})();
	return { url, title: cleanTitle(fileName) };
}

// ==============================
// NEW — SW-DRIVEN SONG CACHING
// ==============================
async function cacheSongAsset(song) {
	if (!song?.url) return;

	// Ensure SW is controlling the page after first load
	if (!navigator.serviceWorker.controller) {
		alert("Reload the page once to enable offline caching.");
		return;
	}

	// Ask SW to download + cache the song
	navigator.serviceWorker.controller.postMessage({
		type: "CACHE_SONG_URL",
		url: song.url
	});
}

// ==============================
// CACHE REMOVAL (still OK to use Cache API)
// ==============================
async function removeSongFromCache(song) {
	if (!song?.url || !('caches' in window)) return;
	try {
		const cache = await caches.open(SONG_CACHE_NAME);
		await cache.delete(song.url);
	} catch (err) {
		console.warn('Failed to delete cached song', err);
	}
}

// ==============================
// LOCAL SONG SYNC
// ==============================
async function syncLocalSongsWithCache() {
	if (!('caches' in window)) return false;
	try {
		const cache = await caches.open(SONG_CACHE_NAME);
		const requests = await cache.keys();
		const cachedUrls = requests.map(r => r.url).filter(isSongUrl);
		const cachedSet = new Set(cachedUrls);

		const beforeLength = localSongs.length;
		const existingMap = new Map(localSongs.map(song => [song.url, song]));

		localSongs = localSongs.filter(song => cachedSet.has(song.url));
		let changed = localSongs.length !== beforeLength;

		cachedUrls.forEach(url => {
			if (!localSongs.some(song => song.url === url)) {
				const record = existingMap.get(url) || inferSongMetadata(url);
				localSongs.push(record);
				changed = true;
			}
		});

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

	localSongs = localSongs.map(song => {
		const match = publicMap.get(song.url);
		if (!match) return song;

		const merged = { ...song, ...match };
		if (!changed) {
			for (const key in merged) {
				if (merged[key] !== song[key]) {
					changed = true;
					break;
				}
			}
		}
		return merged;
	});

	if (changed) saveLocalSongs();
}

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
queueAddBtn.onclick = () => {
	if (selectedList === 'queue' || selectedIndex < 0) return;
	const list = getListByName(selectedList);
	const song = list[selectedIndex];
	if (!song) return;
	queueSongs.push(song);
	selectedList = 'queue';
	selectedIndex = queueSongs.length - 1;
	renderLists();
};

removeBtn.onclick = async () => {
	if (selectedIndex < 0) return;

	const list = getListByName(selectedList);
	if (!list.length) return;

	const [removed] = list.splice(selectedIndex, 1);

	if (selectedList === 'local' && removed) {
		await removeSongFromCache(removed);
		saveLocalSongs();
	}

	if (selectedIndex >= list.length) selectedIndex = list.length - 1;
	renderLists();
};

cacheBtn.onclick = async () => {
	if (selectedList !== 'public' || selectedIndex < 0) return;

	const song = publicSongs[selectedIndex];
	cacheBtn.disabled = true;

	try {
		await cacheSongAsset(song);
		await syncLocalSongsWithCache();
	} catch (err) {
		alert('Failed to cache song. Please check your connection.');
		console.error('Failed to cache song', err);
	} finally {
		cacheBtn.disabled = false;
		renderLists();
	}
};

// ==============================
// Install Prompt
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

// ==============================
// Queue System (drag-drop)
// ==============================
listQueueEl.addEventListener('dragover', e => {
	e.preventDefault();
	e.dataTransfer.dropEffect = 'copy';
});

// allow reordering inside queue
listQueueEl.addEventListener('drop', e => {
	e.preventDefault();

	// reordering existing queue items
	const movingIndex = e.dataTransfer.getData('text/queue-index');
	if (movingIndex !== "") {
		const from = parseInt(movingIndex, 10);
		if (Number.isNaN(from)) return;

		const rect = listQueueEl.getBoundingClientRect();
		const y = e.clientY - rect.top + listQueueEl.scrollTop;

		// find insert index
		let to = 0;
		for (let i = 0; i < listQueueEl.children.length; i++) {
			const c = listQueueEl.children[i];
			if (y > c.offsetTop + c.offsetHeight / 2) to = i + 1;
		}

		const [item] = queueSongs.splice(from, 1);
		queueSongs.splice(to, 0, item);
		selectedList = 'queue';
		selectedIndex = Math.min(to, queueSongs.length - 1);
		renderLists();
		return;
	}

	// dragging in from public / local
	const url = e.dataTransfer.getData('text/song-url');
	const source = e.dataTransfer.getData('text/song-source');
	if (!url) return;

	let song = null;
	if (source === 'public') song = publicSongs.find(s => s.url === url);
	else if (source === 'local') song = localSongs.find(s => s.url === url);
	if (!song) song = inferSongMetadata(url);

	queueSongs.push(song);
	selectedList = 'queue';
	selectedIndex = queueSongs.length - 1;
	renderLists();
});

// ==============================
// Service Worker Registration
// ==============================
if ('serviceWorker' in navigator) {
	navigator.serviceWorker.register('sw.js')
		.then(() => console.log('SW registered'))
		.catch(() => { });
}

// ==============================
// Init
// ==============================
(async function init() {
	bindMediaControls();
	loadLocalSongs();
	renderLists();

	const updated = await syncLocalSongsWithCache();
	if (updated) renderLists();

	fetchSongs();
})();
