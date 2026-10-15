Vendored for Orchy's voice calls (no CDN at runtime).
@elevenlabs/client 1.25.0 (released 2026-09-07), bundled with esbuild 0.25.10: client-1.25.0.js; its worklets rawAudioProcessor.js, audioConcatProcessor.js.
@alexanderolsen/libsamplerate-js 2.1.2: libsamplerate-2.1.2.worklet.js (only loaded when the browser can't record at 16 kHz).

Licenses: LICENSE-elevenlabs-client.txt (the client), LICENSE-libsamplerate-js.txt, and THIRD_PARTY_NOTICES.txt
(everything bundled into client-1.25.0.js, and the wavefile code in the two worklets).
