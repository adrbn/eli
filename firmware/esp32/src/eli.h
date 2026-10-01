// State shared by the tasks: HTTP (core 0) writes it, the audio task plays clips, the render loop (core 1) reads it.
#pragma once
#include <atomic>
#include <deque>
#include <mutex>

#include "clip.h"
#include "face.h"

struct Shared {
  std::mutex mu;  // guards everything below that isn't atomic
  std::deque<eli::Clip*> queue;  // waiting clips, owned
  size_t queuedBytes = 0;
  eli::Clip* playing = nullptr;  // owned by the audio task; read only under mu
  std::atomic<uint32_t> played{0};  // samples handed to I2S for `playing`
  std::atomic<bool> abortPlaying{false};
  uint32_t clipSeq = 0;
  int minTurn = 0, lastTurn = 0;  // clips from turns < minTurn are leftovers of an interrupted answer
  eli::Mode mode = eli::Mode::Idle;  // background mood from POST /state: Idle, Listen or Think
  bool hasGaze = false;
  float gazeX = 0, gazeY = 0;
  int theme = 0;
  bool wake = false;  // ask the render loop for Face::wake()
  std::atomic<bool> ptt{false};
  std::atomic<float> micLevel{0};
};
extern Shared g;

// Stop speaking and drop the queue (keepMusic: a song keeps playing). Caller holds g.mu.
void stopPlayback(bool keepMusic);

void speakerBegin();
extern const uint32_t SPEAKER_LATENCY;  // samples queued in DMA, not yet heard: the lips subtract them
void neckBegin();
void neckUpdate(float gx, float gy, float dt);
void pttBegin();
void httpBegin();
