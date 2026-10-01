// Eli's face on an ESP32-S3: Wi-Fi + mDNS, the face endpoints (http_face.cpp), the speaker (speaker.cpp),
// the servo neck (neck.cpp), push-to-talk (ptt.cpp). This loop is the web page's frame(): sense → behave → draw.
#include <Arduino.h>
#include <ESPmDNS.h>
#include <U8g2lib.h>
#include <WiFi.h>

#include <algorithm>

#include "config.h"
#include "eli.h"
#include "pixel.h"

#if !__has_include("secrets.h")
#error "Copy include/secrets.example.h to include/secrets.h and fill in your Wi-Fi."
#endif
#include "secrets.h"

#if OLED_TYPE == 0
U8G2_SSD1309_128X64_NONAME0_F_HW_I2C oled(U8G2_R0, OLED_RST, OLED_SCL, OLED_SDA);
#elif OLED_TYPE == 1
U8G2_SH1106_128X64_NONAME_F_HW_I2C oled(U8G2_R0, OLED_RST, OLED_SCL, OLED_SDA);
#else
U8G2_SSD1306_128X64_NONAME_F_HW_I2C oled(U8G2_R0, OLED_RST, OLED_SCL, OLED_SDA);
#endif

Shared g;

namespace {
eli::Face face;
uint32_t lastClip = 0;  // id of the clip heard last frame (0 = none)
float lastAt = -1;
uint32_t holdUntil = 0, moodUntil = 0;
int theme = 0;

void splash(const char* a, const char* b) {
  oled.clearBuffer();
  oled.setFont(u8g2_font_6x10_tf);
  oled.drawStr(0, 24, a);
  oled.drawStr(0, 42, b);
  oled.sendBuffer();
}

// main.js sense(): what the face perceives right now. Reads the shared state under the lock, briefly.
eli::Sense sense(uint32_t now) {
  eli::Sense s;
  std::lock_guard<std::mutex> lock(g.mu);
  s.mode = g.mode;
  s.hasGaze = g.hasGaze;
  s.gazeX = g.gazeX;
  s.gazeY = g.gazeY;
  theme = g.theme;
  if (g.wake) {
    face.wake();
    g.wake = false;
  }
  const eli::Clip* c = g.playing;
  const uint32_t id = c ? c->id : 0;
  if (lastClip && id != lastClip) s.clipEnd = true;
  if (c && c->mood >= 0) {  // the sentence's emotion, lingering a little after it
    face.mood = c->mood;
    moodUntil = now + 1500;
  } else if (now > moodUntil) {
    face.mood = -1;
  }
  if (c) {
    const uint32_t played = g.played;
    const float at = (played > SPEAKER_LATENCY ? played - SPEAKER_LATENCY : 0) / static_cast<float>(c->rate) + MOUTH_LEAD_MS / 1000.0f;
    const float prev = id == lastClip ? lastAt : -1;
    if (!c->music) {
      s.mode = eli::Mode::Speak;
      s.hasMouth = eli::mouthAt(*c, at, s.mouth);
      s.phraseStart = eli::crossed(*c, eli::F_START, prev, at);
      s.pause = eli::crossed(*c, eli::F_PAUSE, prev, at);
    } else {  // no beat tracking here: sway at ~120 bpm, eyes swell with the loudness
      s.mode = eli::Mode::Sing;
      s.sway = 3.14159265f * at;
      s.energy = eli::levelAt(*c, at);
    }
    lastAt = at;
    holdUntil = now + 350;
  } else if (now < holdUntil) {
    s.mode = eli::Mode::Speak;  // between two sentences: no flash back to "thinking"
  }
  lastClip = id;
  if (g.ptt) {
    s.mode = eli::Mode::Listen;
    s.micLevel = g.micLevel;
  }
  return s;
}

// Once connected (now or later: the face runs offline meanwhile), announce eli.local. Returns true when online.
bool announce() {
  static bool done = false;
  if (done || WiFi.status() != WL_CONNECTED) return done;
  done = true;
  MDNS.begin(MDNS_NAME);
  MDNS.addService("http", "tcp", HTTP_PORT);
  Serial.printf("eli: http://%s.local  http://%s  -> FACE_URL in the server's .env\n", MDNS_NAME, WiFi.localIP().toString().c_str());
  return true;
}

void connect() {
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(MDNS_NAME);
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(false);  // modem sleep adds 100+ ms stalls to every request
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  for (uint32_t t0 = millis(); WiFi.status() != WL_CONNECTED && millis() - t0 < 15000;) delay(100);
  if (!announce()) {
    Serial.println("wifi: not connected yet; the face runs offline and keeps retrying");
    splash("Wi-Fi: not yet", "retrying...");
    delay(1500);
    return;
  }
  splash("http://" MDNS_NAME ".local", WiFi.localIP().toString().c_str());  // what to put in FACE_URL
  delay(2500);
}
}  // namespace

void setup() {
  Serial.begin(115200);
  srand(esp_random());
  oled.setBusClock(OLED_I2C_HZ);
  oled.begin();
  oled.setFlipMode(OLED_FLIP);
  if (!psramFound()) {  // clips then live in the small internal heap: only short ones will fit
    Serial.println("eli: no PSRAM! check the board env in platformio.ini");
    splash("No PSRAM found", "short clips only");
    delay(2000);
  }
  splash("Eli", "connecting to Wi-Fi...");
  connect();
  speakerBegin();
  neckBegin();
  pttBegin();
  httpBegin();
}

void loop() {
  static uint32_t last = micros();
  const uint32_t now = micros();
  if (now - last < 1000000 / FPS) {
    vTaskDelay(1);
    return;
  }
  const float dt = std::min(0.05f, (now - last) / 1e6f);
  last = now;
  const eli::FaceOut f = face.update(dt, sense(millis()));
  eli::renderFace(theme, f, oled.getBufferPtr());
  oled.sendBuffer();
  announce();
  neckUpdate(f.eyes.gx, f.eyes.gy, dt);
}
