// Plays the clip queue through a MAX98357A, strictly in order, one clip after the other (web/js/audio.js).
#include <Arduino.h>
#include <driver/i2s.h>

#include <algorithm>

#include "config.h"
#include "eli.h"

namespace {
constexpr i2s_port_t PORT = I2S_NUM_0;
constexpr int DMA_COUNT = 8, DMA_LEN = 256;
constexpr uint32_t CHUNK = 256;
}  // namespace

const uint32_t SPEAKER_LATENCY = DMA_COUNT * DMA_LEN;

void stopPlayback(bool keepMusic) {
  for (auto it = g.queue.begin(); it != g.queue.end();) {
    if (keepMusic && (*it)->music) {
      ++it;
      continue;
    }
    g.queuedBytes -= (*it)->bytes;
    delete *it;
    it = g.queue.erase(it);
  }
  if (g.playing && !(keepMusic && g.playing->music)) g.abortPlaying = true;
}

static void audioTask(void*) {
  static int16_t stereo[2 * CHUNK];
  uint32_t rate = 0;
  for (;;) {
    eli::Clip* c = nullptr;
    {
      std::lock_guard<std::mutex> lock(g.mu);
      if (!g.queue.empty()) {
        c = g.queue.front();
        g.queue.pop_front();
        g.queuedBytes -= c->bytes;
        g.played = 0;
        g.abortPlaying = false;
        g.playing = c;
      }
    }
    if (!c) {
      vTaskDelay(pdMS_TO_TICKS(10));
      continue;
    }
    if (c->rate != rate) {  // the voice decides: 22.05 kHz for Piper, more with the cat filter, 16 kHz…
      rate = c->rate;
      i2s_set_clk(PORT, rate, I2S_BITS_PER_SAMPLE_16BIT, I2S_CHANNEL_STEREO);
    }
    // The clip, then a DMA's worth of silence so its tail is heard before the next one (≈ the web page's 60 ms gap).
    const uint32_t total = c->samples + SPEAKER_LATENCY;
    for (uint32_t i = 0; i < total && !g.abortPlaying; i += CHUNK) {
      const uint32_t n = std::min(CHUNK, total - i);
      for (uint32_t k = 0; k < n; k++) {
        const int32_t s = i + k < c->samples ? c->pcm[i + k] * VOLUME_PCT / 100 : 0;
        stereo[2 * k] = stereo[2 * k + 1] = s;  // same on both slots: the amp plays (L+R)/2
      }
      size_t written;
      i2s_write(PORT, stereo, n * 2 * sizeof(int16_t), &written, portMAX_DELAY);
      g.played = i + n;
    }
    if (g.abortPlaying) i2s_zero_dma_buffer(PORT);  // cut now, not after the buffered tail
    std::lock_guard<std::mutex> lock(g.mu);
    g.playing = nullptr;
    delete c;
  }
}

void speakerBegin() {
  i2s_config_t cfg = {};
  cfg.mode = static_cast<i2s_mode_t>(I2S_MODE_MASTER | I2S_MODE_TX);
  cfg.sample_rate = 22050;
  cfg.bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT;
  cfg.channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT;
  cfg.communication_format = I2S_COMM_FORMAT_STAND_I2S;
  cfg.dma_buf_count = DMA_COUNT;
  cfg.dma_buf_len = DMA_LEN;
  cfg.tx_desc_auto_clear = true;  // silence, not a looping buffer, when nothing is written
  i2s_pin_config_t pins = {};
  pins.mck_io_num = I2S_PIN_NO_CHANGE;
  pins.bck_io_num = SPK_BCLK;
  pins.ws_io_num = SPK_LRC;
  pins.data_out_num = SPK_DIN;
  pins.data_in_num = I2S_PIN_NO_CHANGE;
  if (i2s_driver_install(PORT, &cfg, 0, nullptr) != ESP_OK || i2s_set_pin(PORT, &pins) != ESP_OK) {
    Serial.println("speaker: I2S init failed, no sound");
    return;
  }
  xTaskCreatePinnedToCore(audioTask, "audio", 4096, nullptr, 5, nullptr, 1);
}
