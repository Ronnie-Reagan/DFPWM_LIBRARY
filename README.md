# DFPWM Radio

Modern progressive web app for streaming and decoding the DFPWM community playlist.  
Visit the production build at [ronnie-reagan.github.io/DFPWM_LIBRARY](https://ronnie-reagan.github.io/DFPWM_LIBRARY/).

## Features

- Queue/playlist controls with shuffle, repeat (track or queue) and manual re-queueing.
- Dedicated “Now Playing” view that exposes transport controls, progress tracking and caching state.
- Offline cache manager plus per-track downloads so you can save favourites for flights.
- Pop-out player window with Media Session integration for background playback on iOS (lock screen + control centre widgets).
- Legacy client preserved at `legacy.html` for anyone who prefers the original UI/UX.

## Files of interest

| File | Purpose |
| ---- | ------- |
| `index.html` | Primary single-page audio player with queue/offline controls. |
| `popout.html` | Minimal player loaded when the user launches the pop-out window. |
| `legacy.html` / `legacy.js` | Snapshot of the legacy list-based interface. |
| `script.js` | Modern modular controller (queueing, caching, Media Session). |
| `sw.js` | Offline/cache-first service worker for the app shell and song blobs. |

## Development

```bash
npm install -g serve   # or any static HTTP server
serve .
```

The app relies on the service worker and Cache Storage APIs, so test over HTTPS or `http://localhost`. When making large UI changes, update both `index.html` and `popout.html` so the experiences stay in sync. Run `yarn lint` / `npm run lint` if you add tooling to keep `script.js` consistent.
