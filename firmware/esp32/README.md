# Eli on an ESP32-S3

Firmware that turns an ESP32-S3 into Eli's face. It answers the same HTTP routes as the web page, so
the brain (the server) does not change: point `FACE_URL` at the board and it talks to the board instead.

- **Face**: the Pixel family (`pixel`, `blocs`, `perles`) on a 128×64 OLED at 30 fps. Blinks, saccades,
  idle glances, listening and thinking, the eight moods (`X-Mood`), falling asleep after a while. All of it is
  ported from `web/js/face.js` and `themes.js`.
- **Voice**: WAV clips are played through a MAX98357A amp. The mouth follows `X-Phonemes` using the visemes
  from `analysis.js`, and falls back on the sound's loudness when there are no phonemes.
- **Neck** (optional): two servos turn the head toward where the eyes look, slowly and within limits you set.
- **Push-to-talk** (optional): hold the button and talk into an INMP441. On release, the board sends the
  recording to the server's `/brain/listen`, the same way the Space key does on the web page.

> **Status: uncompiled and untested on hardware.** PlatformIO was not available when this was written.
> The hardware-free parts (WAV parsing, mouth track, face behaviour, pixel renderer) are checked on the
> host against the web code (see [Tests](#tests)). The Arduino side (Wi-Fi, HTTP, I2S, LEDC, U8g2) has been
> reviewed by hand and syntax-checked against stub headers, but has never been built with the real
> toolchain. Expect a first round of small fixes.

## Quick start

1. Install [PlatformIO](https://platformio.org/) (VS Code extension or `pipx install platformio`).
2. Create your secrets file and fill in your Wi-Fi details and the server address:
   ```sh
   cp include/secrets.example.h include/secrets.h   # gitignored
   ```
   `SERVER_URL` must be the server's **IP** (for example `http://192.168.1.20:5280`). The server only
   answers IPs, `localhost` and the names listed in `ALLOWED_HOSTS`.
3. Check the pins, the OLED type and the servo limits in [`include/config.h`](include/config.h).
4. Build and flash it, then open the serial monitor:
   ```sh
   pio run -t upload && pio device monitor
   ```
   At boot the OLED shows `http://eli.local` and the board's IP address.
5. In the server's `.env`, set:
   ```sh
   FACE_URL=http://eli.local     # or http://<the IP shown at boot>, if mDNS doesn't resolve
   HOST=0.0.0.0                  # so that the board can reach /brain/listen
   ```
   Restart the server and say something. With push-to-talk, hold the board's **BOOT** button and talk.

Board env: `platformio.ini` targets an **ESP32-S3-DevKitC-1 N16R8** (16 MB flash, 8 MB octal PSRAM). For
an N8R2 (quad PSRAM), change `board_build.arduino.memory_type` to `qio_qspi`; the comments in the file show
how.

## Wiring

All the modules share **GND**. GPIO 35–37 belong to the octal PSRAM, and 19/20 to USB, so none of them are used.

| Module | Module pin | ESP32-S3 | Notes |
|---|---|---|---|
| OLED (SSD1309 2.42", I2C mode) | GND | GND | |
| | VCC | 3V3 | most modules also accept 5 V |
| | SCK / SCL | GPIO 9 | `OLED_SCL` |
| | SDA | GPIO 8 | `OLED_SDA` |
| | RES | GPIO 10 | `OLED_RST`. This pin must be driven, or the screen stays black |
| | DC | GND | in I2C mode DC selects the address: GND = 0x3C (the default) |
| | CS | GND | |
| OLED (4-pin SH1106 / SSD1306) | GND, VCC, SCL, SDA | GND, 3V3, 9, 8 | set `OLED_RST = 255` and `OLED_TYPE` 1 or 2 |
| MAX98357A amp | VIN | 5V | it pulls the most current after the servos |
| | GND | GND | |
| | BCLK | GPIO 5 | `SPK_BCLK` |
| | LRC | GPIO 6 | `SPK_LRC` |
| | DIN | GPIO 7 | `SPK_DIN` |
| | SD, GAIN | not connected | default is 9 dB, (L+R)/2. The board sends the same sample on both channels |
| | + / − | speaker | 4 Ω 3 W |
| INMP441 mic (optional) | VDD | 3V3 | **3.3 V only** |
| | GND | GND | |
| | SCK | GPIO 15 | `MIC_SCK` |
| | WS | GPIO 16 | `MIC_WS` |
| | SD | GPIO 17 | `MIC_SD` |
| | L/R | GND | left channel. If you tie it to 3V3, set `MIC_RIGHT = true` |
| Push-to-talk | button | GPIO 0 | this is the DevKitC's **BOOT** button, so nothing to wire. For an external button, wire any free GPIO to GND and set `PTT_PIN` |
| Pan servo (optional) | signal (orange) | GPIO 13 | `NECK_PAN.pin` |
| Tilt servo (optional) | signal (orange) | GPIO 14 | `NECK_TILT.pin` |
| both servos | + (red), − (brown) | **5 V rail**, GND | from the 5 V supply, not from the board. Put the 1000 µF cap across + and − |

### Power

Two MG90S servos can draw more than 1 A each when they start or stall, which is more than the USB port or the
DevKitC's regulator can give. Use the 5 V 3 A supply as follows:

- Connect the supply to a breadboard rail (through a USB-C breakout). Feed the servos, the MAX98357A and the
  DevKitC's **5V** pin from that rail.
- Put the 1000 µF capacitor across the rail, close to the servos and with the polarity right (the stripe goes to
  GND). It absorbs the current spikes that would otherwise reset the ESP32 or make the speaker click.
- Don't power the board from both the 5V pin and its USB port at the same time. To flash it, unplug the rail, or
  just unplug the servos' + wire and flash over USB.

### OLED: 2.42 inch SSD1309 in I2C mode

The 2.42" modules (sold in green, Eli's colour, as well as white, blue and yellow) usually leave the factory set
up for **SPI**. Switching them to I2C takes a soldering iron:

1. On the back there is a small table printed on the board, typically `IIC: R3 R5 / 4SPI: R4`. Move the 0 Ω
   resistor from **R4** to **R3**, and bridge **R5** with a 0 Ω resistor or a solder blob. Labels vary between
   sellers, so follow the table printed on your board.
2. Wire the board as in the table above. SCK becomes SCL, and DC and CS go to GND. RES goes to a GPIO: U8g2 pulses
   it at boot, and if RES is left floating the screen stays black.
3. If nothing shows up, run an I2C scan. The module should answer at 0x3C (or at 0x3D if DC is tied to 3V3).

The firmware uses `U8G2_SSD1309_128X64_NONAME0_F_HW_I2C`. If the picture is shifted by two columns or comes
out as noise, try `NONAME2` in `src/main.cpp`. The two variants differ only in their init sequence.

The default I2C clock is 400 kHz, which takes about 25 ms per full frame, so 30 fps fits. Many modules also run
at 800 kHz (`OLED_I2C_HZ`).

## Shopping list

Prices are **approximate** (autumn 2026, in euros, single units including shipping) and change all the time.
AliExpress is cheap but takes 1–3 weeks to arrive. Amazon.it delivers the next day but usually sells packs of
2–5.

| Part | Exact search term | Qty | AliExpress | Amazon.it | Notes |
|---|---|---|---|---|---|
| ESP32-S3 board | `ESP32-S3-DevKitC-1 N16R8` | 1 | ~€6–9 | ~€12–18 | must have **PSRAM** (the R8 part). N8R2 works too with a one-line change |
| OLED 2.42" green (recommended) | `2.42 inch OLED 128x64 SSD1309 green` | 1 | ~€8–12 | ~€15–22 | ships in SPI mode, so expect to [move two resistors](#oled-242-inch-ssd1309-in-i2c-mode). Take one with a RES pin (7-pin header) |
| or OLED 1.3" (alternative) | `1.3 inch OLED SH1106 I2C 128x64` | 1 | ~€3–5 | ~€8–12 | 4 pins, plug and play, but smaller. `OLED_TYPE 1` |
| I2S amplifier | `MAX98357A I2S amplifier` | 1 | ~€1.5–3 | ~€6–9 | |
| Speaker | `speaker 40mm 4 ohm 3W` | 1 | ~€1.5–3 | ~€7–10 | |
| I2S microphone (optional) | `INMP441 I2S microphone` | 1 | ~€2–3 | ~€7–10 | only needed for push-to-talk |
| Servos (optional) | `MG90S metal gear servo` | 2 | ~€5–8 (pair) | ~€10–15 | metal gears hold the head better than SG90 |
| Pan/tilt bracket (optional) | `pan tilt bracket SG90 MG90S` | 1 | ~€2–4 | ~€8–12 | the plastic kits fit MG90S |
| Push button (optional) | `tactile push button 6x6` | 1 | ~€1 (pack) | ~€5 (assortment) | only if you don't want to use the BOOT button |
| Capacitor | `1000uF 16V electrolytic capacitor` | 1 | ~€1 (pack) | ~€5 (assortment) | 10 V or more |
| Power supply | `5V 3A USB-C power supply` | 1 | ~€4–7 | ~€8–12 | plus a `USB-C breakout board female` (~€1 / ~€6) to bring 5 V to the breadboard |
| Wiring | `breadboard 830 dupont jumper wires kit` | 1 | ~€3–5 | ~€8–12 | both female–female and male–female wires |

Total: roughly **€35–55** from AliExpress or **€90–130** from Amazon.it. Without the neck and the mic, take off
about €10 or €25.

## Calibrating the neck

The servo calibration is in `include/config.h` (`NECK_PAN`, `NECK_TILT`). Calibrate one servo at a time:

1. Set `rangeDeg = 0` and flash. The servo now holds `centerDeg + trimDeg`. Adjust `trimDeg` until the head looks
   straight ahead (and level, for the tilt servo).
2. Bring `minDeg` and `maxDeg` in until the linkage never binds at either end. The firmware never goes past these
   hard limits.
3. Set `rangeDeg` to how far the head should turn for a full look to the side (gaze ±1). A negative value reverses
   the direction.
4. If 90° isn't square, adjust the pulse widths `usAt0` and `usAt180` (MG90S ≈ 500/2500 µs, SG90 ≈ 500/2400 µs)
   rather than the trim.

`NECK_FOLLOW` sets how much of the eyes' movement the head takes over. `NECK_EASE` sets how fast the head moves,
`NECK_MAX_DEG_S` caps its speed, and `NECK_DEADBAND_DEG` stops servo jitter. Set `NECK_ENABLED = false` if you
have no servos.

## What the board implements

| Route | |
|---|---|
| `POST /clip` | WAV, 16-bit PCM mono, 8–48 kHz, up to 3 MB (about 68 s at 22 kHz). It reads the `X-Phonemes` and `X-Mood` headers and the `turn` and `kind` query parameters (`X-Text` is ignored). Clips from an old turn are dropped, as on the web page. Replies `{"ok": true, ...}` |
| `POST /stop` | `{}` (a human stop: drops the turn in flight), `{"turn": N}`, `{"keep": "music"}` |
| `POST /state` | `{"mode": "idle" \| "listen" \| "think"}` |
| `POST /gaze` | `{"x": -1..1, "y": -1..1}`, or `{}` to free the gaze |
| `POST /theme` | `{"id": "pixel" \| "blocs" \| "perles"}` |
| `GET /`, `/status` | JSON: theme, mode, queue, turn, free memory |

Every reply is JSON. Inputs from the network are validated: the size limits (`MAX_CLIP_BYTES`, `QUEUE_BYTES`,
headers, JSON) are in `config.h`. Requests are only served if their `Host` is an IP or `eli.local`, and form-like
POSTs are rejected. These are the same guards as on the server, against DNS rebinding and cross-site POSTs.

### Not there (yet)

- **Music is refused.** The server sends songs from Navidrome as MP3, and the board only decodes WAV. It answers
  415, and the brain may then say that something went wrong. Possible fixes: have the server send WAV to a
  hardware face, or add an MP3 decoder (for example the ESP8266Audio library) to the firmware.
- No snoring sound while asleep, no cat theme, and no beat tracking while singing (the head sways at a fixed
  tempo instead).
- No `/events` (that is the web page's live stream). The line faces and the matrix need a bigger, round screen,
  so they are not ported.

## Code map

| File | |
|---|---|
| `src/main.cpp` | Wi-Fi, mDNS, the 30 fps loop: sense → `Face::update` → draw → neck |
| `src/http_face.cpp` | small HTTP server for the face routes. It is custom, because `X-Phonemes` headers reach about 7 kB |
| `src/speaker.cpp` | the queue of clips, I2S output, re-clocked to each clip's sample rate |
| `src/neck.cpp` | the two servos, with easing, a speed cap and limits |
| `src/ptt.cpp` | push-to-talk: I2S mic → WAV → `POST /brain/listen` |
| `src/clip.cpp` | WAV parsing and the mouth track (port of `analysis.js`). Pure C++ |
| `src/face.cpp` | behaviour (port of `face.js`). Pure C++ |
| `src/pixel.cpp` | the Pixel-family renderer (port of `themes.js`), drawing straight into the OLED's buffer. Pure C++ |

## Tests

The three pure C++ files compile on any computer. A check builds them with the host compiler, runs native asserts,
and compares them with the web code: loudness, phrase starts and pauses (250 frames), visemes (140 frames), and
seven faces rendered pixel by pixel against `web/js/themes.js`.

```sh
node firmware/esp32/test/check.mjs     # needs node and a C++17 compiler (c++ / clang++ / g++)
```
