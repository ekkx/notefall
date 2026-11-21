# Hand motion runtime (built files)

Built artifacts, copied in as they are; do not edit them here.

| File | What |
|---|---|
| `hands.js` + `hands.d.ts` | the client the app imports (`../motion.ts`): starts the Worker, loads the motion data, makes a song's motion, returns poses |
| `hands-worker.js` | the Worker script |
| `hands.wasm` | the WebAssembly module (used by the Worker and, for the poses, by the client) |

The motion data (`motion.<hash>.bin`, ~22 MB) is not in the repository: it is hosted on the sample CDN under `hands/` and
downloaded by the Worker when hands are turned on (see `../motion.ts`).
