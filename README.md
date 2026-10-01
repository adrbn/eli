<div align="center">

<picture>
  <source media="(prefers-color-scheme: light)" srcset="assets/hero-light.svg">
  <img src="assets/hero.svg" alt="Eli: a green pixel face on a little black OLED screen, talking, blinking and smiling" width="760">
</picture>

# Eli

**A face for your LLM.** A little green-on-black robot that talks with real lips, looks at you,
dozes off when you ignore it, and sings along to your music.

<a href="#quick-start"><img src="assets/btn-start.svg" alt="Quick start" height="40"></a>&nbsp;
<a href="#faces"><img src="assets/btn-faces.svg" alt="Faces" height="40"></a>&nbsp;
<a href="#protocol"><img src="assets/btn-protocol.svg" alt="Protocol" height="40"></a>&nbsp;
<a href="#roadmap"><img src="assets/btn-roadmap.svg" alt="Roadmap" height="40"></a>

<br>

![Python 3.10+](https://img.shields.io/badge/python-3.10%2B-46ff86?style=flat-square&labelColor=0c0f0c&logo=python&logoColor=46ff86)
![Local-first](https://img.shields.io/badge/local--first-yes-46ff86?style=flat-square&labelColor=0c0f0c)
![Face: no cloud](https://img.shields.io/badge/face-no%20cloud-46ff86?style=flat-square&labelColor=0c0f0c)
![ESP32-ready](https://img.shields.io/badge/ESP32-ready%20protocol-46ff86?style=flat-square&labelColor=0c0f0c&logo=espressif&logoColor=46ff86)
![No build step](https://img.shields.io/badge/build%20step-none-46ff86?style=flat-square&labelColor=0c0f0c)
![License MIT](https://img.shields.io/badge/license-MIT-46ff86?style=flat-square&labelColor=0c0f0c)

English · [Français](README.fr.md)

</div>

---

Eli is a talking face you can plug an LLM into. Hold <kbd>Space</kbd>, say something, and a tiny OLED-style face
answers out loud, its mouth shaped by the actual phonemes it speaks. Leave it alone and it glances around, hums,
yawns, and eventually falls asleep, snoring in time with its breathing. Drop a song on it and it dances on the beat,
then sings the isolated vocal line, eyes closing on the high notes.

Today it runs in your browser, served by a small Python stdlib server. Tomorrow the same face goes on an **ESP32**
with a 128×64 OLED: the brain only ever talks to the face over a [tiny HTTP protocol](#protocol), so swapping the
browser for a board is one URL.

## What it does

<table>
  <tr>
    <td align="center" width="33%"><img src="assets/card-talk.svg" alt="Eli talking" width="100%"><br><b>Talks with real lips</b><br><sub>Mouth driven by the audio <i>and</i> Piper's phoneme alignments (visemes), 100 frames a second.</sub></td>
    <td align="center" width="33%"><img src="assets/card-listen.svg" alt="Eli listening" width="100%"><br><b>Listens when you hold Space</b><br><sub>Push-to-talk, wide eyes, little nods. Talk over it and it stops and drops its answer.</sub></td>
    <td align="center" width="33%"><img src="assets/card-sing.svg" alt="Eli singing" width="100%"><br><b>Sings and dances</b><br><sub>Drop a song: it bounces on the beat, isolates the vocals with an MDX model and sings along.</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="assets/card-sleep.svg" alt="Eli sleeping" width="100%"><br><b>Gets sleepy</b><br><sub>Idle gestures, then drowsy, then asleep: breathing, Zzz and a synthesized snore.</sub></td>
    <td align="center"><img src="assets/card-cat.svg" alt="Eli as a cat" width="100%"><br><b>Can be a cat</b><br><sub>Cat faces twitch their ears, meow on their own and purr in their sleep.</sub></td>
    <td align="center"><img src="assets/card-faces.svg" alt="Some of Eli's faces" width="100%"><br><b>14 faces</b><br><sub>OLED pixels, blocks, beads, round line faces, neon, LED matrix, oscilloscope, cats.</sub></td>
  </tr>
</table>

**And also**

- **Streams its answers.** The LLM streams, and each sentence is voiced as soon as it ends: the first words come out while the rest is still being written.
- **Remembers you.** The conversation survives restarts, and after a quiet spell the LLM distils it into a plain-text notebook of durable facts (`memory/souvenirs.md`, one per line, edit it by hand if you like).
- **Introduces itself.** On first launch Eli asks your name and a few questions to get to know you.
- **Says English words properly.** Eli's voice is French; English words wrapped in `[en]…[/en]` are spoken with English phonemes in the same voice, so song titles don't come out mangled.
- **Optional cat voice.** A higher-pitched filter that only applies while a cat face is on screen.
- **Mini music player** in the dock, to pause and seek the song it's singing.
- **Scriptable from the terminal** with [`./send.sh`](#from-the-terminal), over the same protocol the ESP32 will use.

## Quick start

You need [`uv`](https://docs.astral.sh/uv/), a free [Groq API key](https://console.groq.com/keys), and `ffmpeg` if you want it to sing.

```bash
git clone https://github.com/adrbn/eli && cd eli
cp .env.example .env        # then put your GROQ_API_KEY in it
./run.sh
```

That's it. `http://127.0.0.1:5280` opens, Eli wakes up and introduces itself.
The first run downloads a Piper voice (~60 MB) and the vocal-separation model (~65 MB).
`./run.sh --no-open` starts the server without opening a browser.

> [!TIP]
> In Safari, **File › Add to Dock** turns Eli into a real app window. Browsers want one click before they play
> sound: if needed, a "click to wake Eli" banner shows up.

## Native apps

**macOS** (`apps/macos`, no Xcode project, needs the Xcode command-line tools):

```bash
apps/macos/build.sh          # → apps/macos/build/Eli.app, signed with your Developer ID
```

`Eli.app` starts the server if nothing answers on the port (and stops it on quit, only if it started it), finds the
repo when the app sits inside it, otherwise asks for the folder once. Three ways to show Eli, combinable from the
menu-bar icon: **Window** (the full page), **Widget** (a floating face you drag anywhere, it snaps to edges and
corners; resize from the corner or with a pinch, double-click opens the window), **Notch** (a pill around the
MacBook notch that grows on hover). Only one of them speaks, the others mirror it.
Server output goes to `~/Library/Logs/Eli/server.log`; another port: `defaults write com.adrbn.eli.mac port 5281`.
Keep `HOST` on `127.0.0.1` or `0.0.0.0`: the app talks to `127.0.0.1`.

**iPhone** (`apps/ios`, needs [`xcodegen`](https://github.com/yonaskolb/XcodeGen)): `cd apps/ios && xcodegen`, open
`Eli.xcodeproj`, pick your team, run. On first launch, type the address of the computer running Eli (e.g. its
Tailscale IP, `100.x.y.z:5280`). Its `HOST` in `.env` must be reachable from the phone (`0.0.0.0`, or that IP).
The app relays the server through `127.0.0.1` on the phone, so the microphone works over plain http.
Long-press with two fingers to change the address.

## Controls

| Input | What happens |
|---|---|
| Type in the bar, <kbd>Enter</kbd> | It thinks (eyes searching up), then answers out loud. <kbd>Enter</kbd> anywhere focuses the bar. |
| Start the message with `>` | It says your text verbatim, no LLM involved |
| Hold <kbd>Space</kbd> (or the mic button) | It listens; release to send: transcription → answer → voice |
| Say **"Eli, …"** (Settings → *Écoute permanente*) | Hands-free. A small offline model flags anything that sounds like its name; only those snippets are transcribed. "Eli" alone: it opens its eyes and waits for the rest |
| Talk while it talks | It stops and abandons its answer |
| Drop an audio file on the window | **Talk** zone: the mouth follows the voice. **Sing** zone: it dances, then sings the isolated vocals |
| Move the mouse | Its gaze follows you (that's the simulated sensor) |
| <kbd>←</kbd> / <kbd>→</kbd> | Previous / next face |
| <kbd>V</kbd> | Face gallery, with the "custom" face's settings |
| <kbd>P</kbd> | Play / pause the song |
| <kbd>↑</kbd> / <kbd>↓</kbd> | Recall previously sent messages, like a shell |
| <kbd>Esc</kbd> | Closes panels and shuts it up (the song keeps playing) |
| Do nothing for 2 min | It gets drowsy, then falls asleep a minute later; anything wakes it |

The **Settings** panel (bottom right) has mouth lead time, volume, voice choice, the cat voice filter, subtitles,
mouse gaze, sleep sounds, "stop talking", "forget the conversation", its memory notebook, "get to know each other"
(replays the intro) and "forget everything".

## Faces

Same behaviour, different renderers. Your pick is remembered and synced across open pages.

| Family | Id | Look | Target screen |
|---|---|---|---|
| Pixel | `pixel` *(default)* | every pixel of a 128×64 OLED | 0.96″ / 1.3″ OLED |
| Pixel | `blocs` | chunky square pixels | 128×64 OLED |
| Pixel | `perles` | plus-shaped pixels | 128×64 OLED |
| Pixel | `perles-fond` | round LEDs, unlit ones stay visible | colour screen |
| Pixel | `grille` | custom: density, shape (square / bead) and background | colour screen |
| Line | `trait` | round eyes, drawn lips | round 240×240 |
| Line | `trait-doux` | soft rounded-rectangle eyes, filled | round 240×240 |
| Line | `trait-contour` | the same, outlined | round 240×240 |
| Line | `trait-neon` | glowing outlines | round, ideally AMOLED |
| Cats | `chat-pixel` | pixel cat, twitching ears | 128×64 OLED |
| Cats | `chat-perles` | bead cat on visible LEDs | colour screen |
| Cats | `chaton` | kitten with big eyes and pink cheeks | round 240×240 |
| Others | `matrice` | 19×19 round-LED matrix | round 240×240 |
| Others | `oscillo` | oscilloscope trace, the mouth is a waveform | 4:3, 320×240 |

Cat faces meow now and then (synthesized, no samples) and purr instead of snoring.

<details>
<summary><b>Add your own face</b></summary>

<br>

Add an entry to `THEMES` in [`web/js/themes.js`](web/js/themes.js):

```js
{ id: 'mine', name: 'Mine', family: 'Others', screen: 'rect', note: 'what it looks like', make: () => draw }
```

`screen` is `rect` (2:1), `round` (1:1) or `wide` (4:3). `make()` returns a drawing function
`(ctx, W, H, f, dt)` called every frame. `f` holds the whole face state, and the face behaviour never depends on the renderer:

- `f.eyes = { gx, gy, open, hap, sc, bo }`: gaze, openness, happy-eye amount, scale, bounce
- `f.mouth = { o, w, r, t }`: opening, width, roundness, teeth
- `f.T`: time in seconds

On the ESP32, a face will be exactly this: one drawing function.

</details>

## How it works

```mermaid
flowchart LR
    mic(["Hold Space"]) -- WAV --> stt["Speech to text<br/>Groq Whisper or<br/>your own server"]
    typed(["Typed text"]) --> llm
    stt --> llm["LLM<br/>Groq, streamed"]
    mem[("Memory<br/>notebook")] <--> llm
    llm -- "sentence by sentence" --> tts["Voice<br/>Piper or macOS say"]
    tts -- "POST /clip<br/>audio + phonemes" --> face["Face<br/>browser canvas<br/>(later: ESP32)"]
    song(["Dropped song"]) -- "POST /clip kind=music" --> face
    song --> mdx["MDX-Net<br/>vocal stem"] -- "SSE stem" --> face
```

- **Server** (`server/`, Python stdlib + Piper + onnxruntime): `app.py` holds the face protocol, `brain.py` the mic → transcription → LLM → voice loop, `voice.py` Piper (fallback: macOS `say`), `stems.py` + `mdx.py` the vocal separation, `memory.py` the conversation and notebook, `meow.py` synthesized meows.
- **Lip sync** (`web/js/analysis.js`, in a worker): each clip is analysed in full before it plays. Five frequency bands give opening, width, roundness (o, oo) and teeth (s, sh, f) at 100 frames a second; when the voice provides phoneme timings (Piper does), visemes built from them take over. The mouth reads the track at the time you *hear* (output latency included), 50 ms early like a real speaker.
- **Gaze** (`web/js/face.js`): it looks away when starting a sentence, comes back to you when finishing it, blinks in pauses, makes small saccades. Without a sensor, centred eyes look at everyone at once.
- **Music**: tempo and beats come from spectral flux and autocorrelation. Meanwhile MDX-Net (UVR's Kim_Vocal_2, ONNX, on CPU) isolates the vocals block by block, faster than playback, so it sings from the first listen. High notes lift and squint the eyes, low notes drop the gaze. Results are cached by file hash.
- **Sleep sounds** (`web/js/sleep.js`): snore and purr are synthesized in the browser, locked to the face's breathing.

## Protocol

The face is a passive screen: you send it audio clips and states, it plays and animates.
The brain only talks to it through these routes, so replacing the page with an ESP32 means putting its address in `FACE_URL`.

```text
POST /clip?kind=speech|music&turn=N&name=f.mp3   body = audio file
                                                  X-Text: spoken text (URL-encoded)
                                                  X-Phonemes: [[phoneme, ms], …] as URL-encoded JSON (optional)
POST /stop    {} or {"turn": N}                   stop talking, clear the queue; then ignore clips from turns < N
              {"keep": "music"}                   …but let the current song play on
POST /state   {"mode": "idle|listen|think"}       background mood
POST /gaze    {"x": -1..1, "y": -1..1} or {}      gaze target (the sensor); {} frees the gaze
POST /theme   {"id": "pixel"}                     switch face
GET  /events                                      SSE stream to the display
GET  /clips/<id>, /stems/<hash>.wav               audio bytes (/clips/<id>?compat=1: transcoded to MP3;
                                                  /stems: isolated vocals, partial while still computing)
```

SSE events: `hello` (full state on connect), `clip`, `stem` (a song's isolated vocals are ready, block by block),
`state`, `gaze`, `theme`, `voice`, `stop` and `brain` (conversation steps, for display).

**Turns.** Every answer from the brain starts with `POST /stop {"turn": N}`. The screen goes quiet and drops any clip
still in flight from earlier turns, so an interrupted answer never comes back to talk over the next one.

The brain, served by the same process:

```text
POST /brain/listen   body = mic WAV          → transcription → answer → voice
POST /brain/chat     {"text": "…"}           → answer → voice
POST /brain/speak    {"text": "…"}           → voice only (says exactly this)
POST /brain/reset    (?all=1: notebook too)  forget the conversation
POST /brain/intro                            the get-to-know-you intro
POST /brain/meow                             one meow (cat faces)
POST /voice          {"id": "…"} / {"cat": true}   pick a voice / toggle the cat filter
GET  /api/status, /api/voices, /api/memory
```

The server listens on `127.0.0.1` only. For an ESP32 on your network, set `HOST=0.0.0.0`; unknown host names and
cross-site requests are already refused.

## From the terminal

```bash
./send.sh dis "Bonjour !"          # say this verbatim
./send.sh demande "Ça va ?"        # ask the LLM, hear the answer
./send.sh parle voice.wav          # play a file, the mouth follows
./send.sh chante song.mp3          # dance and sing
./send.sh regarde 0.6 -0.2         # point the gaze (x, y in -1..1); no values = free gaze
./send.sh visage trait-neon        # switch face
./send.sh humeur think             # mood: idle, listen or think
./send.sh stop                     # stop talking
./send.sh oublie                   # forget the conversation
```

`ELI_URL=http://…` targets another server. (The verbs are French: *dis* = say, *demande* = ask, *parle* = talk,
*chante* = sing, *regarde* = look, *visage* = face, *humeur* = mood, *oublie* = forget.)

## Configuration

Everything lives in `.env` (template: [`.env.example`](.env.example)). Eli needs one brain: `GROQ_API_KEY` (free tier, your own key) or `LLM_URL`.

| Variable | Default | What it does |
|---|---|---|
| `GROQ_API_KEY` | | transcription and LLM |
| `STT_PROVIDERS` | `groq,echo` | transcription order, the next one takes over on failure |
| `ECHO_URL`, `ECHO_API_KEY` | | your own OpenAI-compatible `/v1/audio/transcriptions` server (e.g. Parakeet at home) |
| `STT_LANGUAGE` | `fr` | transcription language |
| `LLM_MODEL`, `LLM_FALLBACK_MODEL` | `openai/gpt-oss-120b`, `openai/gpt-oss-20b` | Groq models |
| `LLM_URL`, `LLM_API_KEY` | | a local OpenAI-compatible brain instead (mlx_lm.server, Ollama…) |
| `TTS`, `SAY_VOICE` | `piper`, `Thomas` | starting voice; switch live in Settings |
| `SEPARATOR_MODEL` | `voices/Kim_Vocal_2.onnx` | the vocal-isolation model |
| `HOST`, `PORT` | `127.0.0.1`, `5280` | where the server listens |
| `FACE_URL` | *(this server)* | where the brain sends clips: later, the ESP32 |
| `BRIEF_CITY` | | city for the morning brief's weather (Open-Meteo, no key) |
| `ALLOWED_HOSTS` | | host names served besides IPs and localhost (e.g. behind `tailscale serve`) |
| `NAVIDROME_URL`, `_USER`, `_PASSWORD` | | your music library; easier from Settings → Music |

Eli's personality is `DEFAULT_PERSONA` in `server/brain.py`; drop a `persona.txt` at the repo root to replace it.

## Run it on a home server (Docker)

The same server runs on a NAS or a mini PC (Linux, amd64 or 64-bit arm64), and every phone, tablet or laptop at home
opens the face in its browser.

```bash
git clone https://github.com/adrbn/eli && cd eli
cp .env.example .env              # put your GROQ_API_KEY in it
mkdir -p voices memory cache local  # created by you, so the container (uid 1000) can write to them
docker compose up -d --build
docker compose logs -f            # wait for "voix : piper · Siwis" then "Eli écoute sur …"
```

- The first start downloads the Piper voice and the vocal-separation model (~130 MB) into `voices/`. Coming from a Mac,
  copy your `memory/` folder over first (and `voices/` to skip the downloads): Eli picks up where it left off.
- Not uid 1000 on the host? Add `ELI_UID=…` and `ELI_GID=…` (from `id -u` and `id -g`) to `.env`.
- Keep `TTS=piper`, and delete `voices/choix.txt` if it names a `say:` voice: macOS voices don't exist on Linux.
- **Singing is CPU-heavy**: isolating a song's vocals runs an ONNX model on 4 threads that peaks around 2.5 GB of RAM
  (an M1 takes ~0.8× the song's length; a small CPU can fall behind playback). `SEPARATOR_MODEL=off` in `.env` turns
  it off (Eli still dances), and the memory limit in `compose.yaml` can then come down to 1 GB.
- Eli has **no login**: anyone who reaches the port can make it talk and read its notebook. Keep it on your LAN or VPN,
  never port-forward it to the internet.

**From a phone or tablet**, open `http://<server-ip>:5280`, on the LAN or through a VPN such as Tailscale or WireGuard.
Use the IP address: Eli only answers to IP addresses and `localhost` (a guard against DNS rebinding), so a hostname like
`nas.local` gets a 403.

Over plain `http://`, everything works except the **microphone** (hold-to-talk and the wake word): browsers only allow
`getUserMedia` in a secure context, meaning HTTPS or `localhost`. You can still type. For the microphone, put HTTPS in
front of Eli, on the same IP:

- **A reverse proxy with TLS**, for instance [Caddy](https://caddyserver.com) with its own local certificate authority.
  It keeps the browser's `Host` header, which Eli checks against `Origin`:

  ```caddy
  # your server's LAN or VPN IP; reverse_proxy eli:5280 if Caddy runs in the same compose project
  https://192.168.1.50:5443 {
      tls internal
      reverse_proxy 127.0.0.1:5280
  }
  ```

  Then install Caddy's root certificate (`pki/authorities/local/root.crt` in Caddy's data folder) on each device once
  and trust it, and open `https://192.168.1.50:5443`.
- **`tailscale serve`** gives a real certificate with no setup, on a `*.ts.net` hostname. Eli only serves IP addresses
  and `localhost` by default (DNS-rebinding guard), so name it in `.env`: `ALLOWED_HOSTS=eli.your-tailnet.ts.net`.
- For a quick test, Chrome (desktop and Android) can treat one origin as secure:
  `chrome://flags/#unsafely-treat-insecure-origin-as-secure`.

## Towards the ESP32

- **Board**: ESP32-S3 with PSRAM (audio buffers), a MAX98357A I2S amp and a small speaker.
- **Screen**: SSD1306 / SH1106 128×64 OLED for the Pixel family (`pixel`, `blocs` and `perles` fit pixel for pixel). Round GC9A01 240×240 for the line faces and the matrix. AMOLED for neon and the visible-LED faces.
- **Mouth**: the plan is for the server to compute the mouth track (the same `analysis.js`) and ship it with the clip; the board then just plays the sound and reads the track at 100 fps.
- **Gaze**: an LD2450 mmWave radar gives people's x/y without a camera; a camera with face detection works too. Either way: `POST /gaze`.

## Roadmap

- [x] Browser simulator with the ESP32 protocol
- [x] Phoneme-driven lip sync, streamed answers, interruption
- [x] Singing on isolated vocals, dancing on the beat
- [x] Memory with consolidation, first-run intro
- [x] Cat faces, meows, purring
- [ ] Karaoke with synced lyrics (LRCLIB)
- [x] Wake word: say "Eli, …" hands-free (local Vosk gate, then your STT confirms; Settings → always listening)
- [x] Emotions: the LLM tags its sentences ([joie], [colère]…) and the eyes and mouth act them out
- [x] "Eli, play some Daft Punk": your Navidrome/Subsonic library; Eli opens the right settings form the first time
- [x] Local brain: any OpenAI-compatible server (`LLM_URL`, e.g. mlx_lm.server or Ollama)
- [x] Home-server version (Docker)
- [ ] Morning brief
- [ ] ESP32 build + servo neck
- [ ] Several Elis talking to each other

## FAQ

<details>
<summary><b>What leaves my machine?</b></summary>

<br>

The face, the voice (Piper), the lip sync, the vocal separation and the memory are all local. Two things go to Groq by
default: your recorded question (for transcription) and the conversation (for the LLM). Set `STT_PROVIDERS=echo,groq`
with your own transcription server and your voice stays home, at the cost of ~2 s more wait.

</details>

<details>
<summary><b>Does it speak English?</b></summary>

<br>

Not yet as a whole: Eli is French-first (interface, voice catalogue, personality). English words inside a sentence are
pronounced properly through `[en]` tags. A full English mode means an English Piper voice, an English persona and
`STT_LANGUAGE=en`.

</details>

<details>
<summary><b>Can I use another LLM?</b></summary>

<br>

Any Groq-hosted model works through `LLM_MODEL`. The calls are plain OpenAI-format HTTP, so another compatible provider
is a matter of changing the `GROQ` base URL in `server/brain.py`.

</details>

<details>
<summary><b>Does it need a GPU?</b></summary>

<br>

No. Vocal separation runs on CPU through onnxruntime, about 1.8× faster than real time on an Apple-silicon Mac, one song
at a time, cached by file hash. Without `ffmpeg` or the model, Eli still dances, it just doesn't sing.

</details>

<details>
<summary><b>Mac only?</b></summary>

<br>

It's built and tested on macOS. The server is stdlib Python and Piper is cross-platform; on Linux use
`./run.sh --no-open` and open the page yourself. The `say` voices are macOS-only.

</details>

<details>
<summary><b>Known limits</b></summary>

<br>

- The first <kbd>Space</kbd> press opens the mic and can eat the first syllable; the mic then stays open 30 s.
- A hidden or minimized window freezes the animation (the sound keeps going).
- Only one tab talks at a time within a browser; a Safari page and a Chrome page open together would both talk.
- Mic capture uses `ScriptProcessor`: deprecated but everywhere, to be swapped for an `AudioWorklet`.

</details>

## Tests

```bash
uv run python -m unittest discover server
node --test 'web/tests/*.test.mjs'
```

The README art is generated from the face code itself: `python3 assets/make_svgs.py`.

## License

[MIT](LICENSE) © 2026 adrbn

Downloaded at first run, under their own terms: the [Piper](https://github.com/rhasspy/piper) Siwis voice (SIWIS
French Speech Synthesis Database, CC BY 4.0), the [Vosk](https://alphacephei.com/vosk/models) small French model
(Apache 2.0), and UVR's Kim_Vocal_2 vocal-isolation model (no license stated by its authors; set
`SEPARATOR_MODEL=off` to skip it). Weather data by [Open-Meteo.com](https://open-meteo.com/) (CC BY 4.0), free for
non-commercial use.
