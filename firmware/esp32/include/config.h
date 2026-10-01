// Everything you may want to tune: pins, servo calibration, limits. Wi-Fi and the server URL live in secrets.h.
#pragma once
#include <stdint.h>

// ---- Network ------------------------------------------------------------------------------------------------
#define MDNS_NAME "eli"  // → http://eli.local ; put that (or the IP shown at boot) in the server's FACE_URL
constexpr uint16_t HTTP_PORT = 80;

// ---- OLED 128x64 (I2C) ---------------------------------------------------------------------------------------
// 0 = SSD1309 (2.42" modules, sold in green: Eli's colour), 1 = SH1106 (most 1.3"), 2 = SSD1306 (most 0.96").
// 2.42" SSD1309 boards usually ship in SPI mode: see README "OLED: 2.42 inch SSD1309 in I2C mode".
#define OLED_TYPE 0
constexpr uint8_t OLED_SDA = 8;
constexpr uint8_t OLED_SCL = 9;
constexpr uint8_t OLED_RST = 10;  // the SSD1309's RES pin; 255 (U8X8_PIN_NONE) for 4-pin modules without one
constexpr uint32_t OLED_I2C_HZ = 400000;  // a full frame takes ~25 ms at 400 kHz; many modules accept 800 kHz
constexpr bool OLED_FLIP = false;         // true if the screen is mounted upside down
constexpr uint32_t FPS = 30;

// ---- Speaker: MAX98357A (I2S) --------------------------------------------------------------------------------
constexpr uint8_t SPK_BCLK = 5;
constexpr uint8_t SPK_LRC = 6;
constexpr uint8_t SPK_DIN = 7;
constexpr int VOLUME_PCT = 60;    // software gain, 0..100 (a 3 W amp on a small speaker is loud)
constexpr int MOUTH_LEAD_MS = 50;  // lips slightly ahead of the sound, like the web page's default

// ---- Microphone: INMP441 (I2S) + push-to-talk button --------------------------------------------------------
constexpr bool MIC_ENABLED = true;
constexpr uint8_t MIC_SCK = 15;
constexpr uint8_t MIC_WS = 16;
constexpr uint8_t MIC_SD = 17;
constexpr int MIC_SHIFT = 14;      // 32-bit sample >> MIC_SHIFT = 16-bit; lower it (13, 12) if speech is too quiet
constexpr bool MIC_RIGHT = false;  // INMP441 L/R pin to GND = left; set true if you only record silence
constexpr uint8_t PTT_PIN = 0;     // BOOT button of the DevKitC (active low); any free GPIO to GND works too
constexpr uint32_t MAX_PTT_S = 30; // same cap as the web page

// ---- Neck: two servos (pan = left/right, tilt = up/down) ----------------------------------------------------
// The head follows the eyes, slowly: it filters out the saccades and keeps the big looks (gaze sensor, glances).
// Calibration, one servo at a time:
//   1. set rangeDeg = 0 and flash: the servo sits at centerDeg + trimDeg. Adjust trimDeg until the head looks
//      straight ahead (level, for the tilt).
//   2. move minDeg/maxDeg in until the linkage never binds at either end: they are hard limits.
//   3. set rangeDeg to how far the head turns for a full look sideways (gaze = ±1). Negative = reversed.
//   4. usAt0/usAt180 are the pulse widths for 0° and 180°: SG90 ≈ 500/2400 µs, MG90S ≈ 500/2500 µs. If 90° is
//      not square, adjust these rather than the trim.
struct ServoCal {
  uint8_t pin;
  float centerDeg, trimDeg, minDeg, maxDeg, rangeDeg;
  uint16_t usAt0, usAt180;
};
constexpr bool NECK_ENABLED = true;
constexpr ServoCal NECK_PAN = {13, 90, 0, 40, 140, 35, 500, 2400};
constexpr ServoCal NECK_TILT = {14, 90, 0, 70, 115, 15, 500, 2400};
constexpr float NECK_FOLLOW = 0.7f;      // share of the eye gaze the head takes over
constexpr float NECK_EASE = 2.5f;        // 1/s: higher = snappier head
constexpr float NECK_MAX_DEG_S = 120.0f; // slew limit: no jerks, gentler on a weak 5 V supply
constexpr float NECK_DEADBAND_DEG = 0.4f;// don't send changes smaller than this (quiets SG90 jitter)

// ---- Limits (inputs come from the network) -------------------------------------------------------------------
constexpr uint32_t MAX_CLIP_BYTES = 3 * 1024 * 1024;  // ~68 s of 22.05 kHz mono
constexpr uint32_t QUEUE_BYTES = 5 * 1024 * 1024;     // all queued clips together (PSRAM is 8 MB)
constexpr uint32_t MAX_JSON = 4096;
constexpr uint32_t MAX_HEADER_LINE = 8192;            // X-Phonemes can reach ~7000 bytes
constexpr uint32_t MAX_HEADERS = 12 * 1024;
constexpr uint32_t BODY_IDLE_TIMEOUT_MS = 5000;
