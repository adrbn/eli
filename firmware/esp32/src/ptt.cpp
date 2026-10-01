// Push-to-talk: hold the button, speak into the INMP441, release → WAV 16 kHz mono to the server's /brain/listen.
// Same flow as the web page's Space key (main.js pttStart/pttEnd).
#include <Arduino.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <driver/i2s.h>

#include <algorithm>
#include <cmath>
#include <cstring>

#include "config.h"
#include "eli.h"
#include "secrets.h"

namespace {
constexpr i2s_port_t PORT = I2S_NUM_1;
constexpr uint32_t RATE = 16000;  // what the speech-to-text expects
constexpr uint32_t MAX_SAMPLES = RATE * MAX_PTT_S;
constexpr uint32_t MIN_SAMPLES = RATE * 3 / 10;  // < 0.3 s = a slip of the finger
constexpr size_t READ = 256;

bool pressed() { return digitalRead(PTT_PIN) == LOW; }

void wavHeader(uint8_t* h, uint32_t samples) {
  const uint32_t bytes = samples * 2;
  const auto u32 = [&](int at, uint32_t v) { for (int i = 0; i < 4; i++) h[at + i] = v >> (8 * i); };
  const auto u16 = [&](int at, uint16_t v) { h[at] = v; h[at + 1] = v >> 8; };
  memcpy(h, "RIFF", 4); u32(4, 36 + bytes); memcpy(h + 8, "WAVEfmt ", 8); u32(16, 16);
  u16(20, 1); u16(22, 1); u32(24, RATE); u32(28, RATE * 2); u16(32, 2); u16(34, 16);
  memcpy(h + 36, "data", 4); u32(40, bytes);
}

// Records while the button is held; returns the number of samples written after the 44-byte header.
uint32_t record(int16_t* pcm) {
  static int32_t raw[READ];
  uint32_t n = 0, releasedAt = 0;
  float x1 = 0, y1 = 0;  // DC blocker: the INMP441 has an offset
  i2s_start(PORT);
  while (n < MAX_SAMPLES) {
    size_t got = 0;
    i2s_read(PORT, raw, sizeof raw, &got, pdMS_TO_TICKS(100));
    float sum = 0;
    for (size_t i = 0; i < got / 4 && n < MAX_SAMPLES; i++) {
      const float x = raw[i] >> MIC_SHIFT, y = x - x1 + 0.995f * y1;
      x1 = x;
      y1 = y;
      pcm[n++] = std::max(-32768.0f, std::min(32767.0f, y));
      sum += y * y;
    }
    if (got) g.micLevel = std::min(1.0f, sqrtf(sum / (got / 4)) / 8000);
    if (pressed()) releasedAt = 0;
    else if (!releasedAt) releasedAt = millis();
    else if (millis() - releasedAt > 30) break;  // debounce the release
  }
  i2s_stop(PORT);
  g.micLevel = 0;
  return n;
}

// POST the recording; the server answers 202 {"ok": true, "turn": N}.
void send(uint8_t* wav, uint32_t samples) {
  HTTPClient http;
  http.begin(String(SERVER_URL) + "/brain/listen");
  http.addHeader("Content-Type", "audio/wav");
  http.setTimeout(20000);
  const int code = http.POST(wav, 44 + samples * 2);
  int turn = -1;
  if (code == 202) {
    JsonDocument doc;
    if (!deserializeJson(doc, http.getString()) && doc["turn"].is<int>()) turn = doc["turn"];
  } else {
    Serial.printf("ptt: /brain/listen failed (%d %s)\n", code, code < 0 ? http.errorToString(code).c_str() : "");
  }
  http.end();
  std::lock_guard<std::mutex> lock(g.mu);
  if (turn >= 0) {
    g.minTurn = std::max(g.minTurn, turn);
    g.lastTurn = std::max(g.lastTurn, turn);
  } else {
    g.mode = eli::Mode::Idle;  // nobody will answer: don't stay stuck "thinking"
  }
}

void pttTask(void*) {
  auto* wav = static_cast<uint8_t*>(eli::bigAlloc(44 + MAX_SAMPLES * 2));
  if (!wav) {
    Serial.println("ptt: no memory for the recording buffer");
    vTaskDelete(nullptr);
  }
  for (;;) {
    while (!pressed()) vTaskDelay(pdMS_TO_TICKS(20));
    vTaskDelay(pdMS_TO_TICKS(30));
    if (!pressed()) continue;
    {  // he's being interrupted: hush, and drop what's left of the answer in flight
      std::lock_guard<std::mutex> lock(g.mu);
      stopPlayback(false);
      g.minTurn = std::max(g.minTurn, g.lastTurn + 1);
      g.wake = true;
    }
    g.ptt = true;
    const uint32_t n = record(reinterpret_cast<int16_t*>(wav + 44));
    g.ptt = false;
    while (pressed()) vTaskDelay(pdMS_TO_TICKS(20));  // hit the 30 s cap: wait for the release
    if (n < MIN_SAMPLES || WiFi.status() != WL_CONNECTED) continue;
    wavHeader(wav, n);
    {
      std::lock_guard<std::mutex> lock(g.mu);
      g.mode = eli::Mode::Think;
    }
    send(wav, n);
  }
}
}  // namespace

void pttBegin() {
  if (!MIC_ENABLED) return;
  pinMode(PTT_PIN, INPUT_PULLUP);
  i2s_config_t cfg = {};
  cfg.mode = static_cast<i2s_mode_t>(I2S_MODE_MASTER | I2S_MODE_RX);
  cfg.sample_rate = RATE;
  cfg.bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT;
  cfg.channel_format = MIC_RIGHT ? I2S_CHANNEL_FMT_ONLY_RIGHT : I2S_CHANNEL_FMT_ONLY_LEFT;
  cfg.communication_format = I2S_COMM_FORMAT_STAND_I2S;
  cfg.dma_buf_count = 4;
  cfg.dma_buf_len = READ;
  i2s_pin_config_t pins = {};
  pins.mck_io_num = I2S_PIN_NO_CHANGE;
  pins.bck_io_num = MIC_SCK;
  pins.ws_io_num = MIC_WS;
  pins.data_out_num = I2S_PIN_NO_CHANGE;
  pins.data_in_num = MIC_SD;
  if (i2s_driver_install(PORT, &cfg, 0, nullptr) != ESP_OK || i2s_set_pin(PORT, &pins) != ESP_OK) {
    Serial.println("ptt: I2S mic init failed, push-to-talk disabled");
    return;
  }
  i2s_stop(PORT);
  xTaskCreatePinnedToCore(pttTask, "ptt", 6144, nullptr, 4, nullptr, 0);
}
