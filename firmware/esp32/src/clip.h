// A clip as the face plays it: 16-bit mono PCM plus a mouth track at 100 frames/s.
// Port of the parts of web/js/analysis.js the board needs. Pure C++ (no Arduino): checked on the host by test/.
#pragma once
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <string>
#include <vector>

namespace eli {

constexpr float HOP = 0.01f;
enum : uint8_t { F_START = 1, F_PAUSE = 2 };  // a phrase starts / a pause begins on this frame

struct Mouth { float o, w, r, t; };  // opening, width, rounding, teeth: 0..1
struct Frame { Mouth m; float lv; uint8_t flags; };

// One phoneme from X-Phonemes: its first code point, how many code points, any letter in it, duration.
struct Phone { uint32_t cp; uint8_t count; bool letter; uint16_t ms; };

void* bigAlloc(size_t n);  // PSRAM on the board, malloc on the host; release with free()

struct Clip {
  uint32_t id = 0;
  bool music = false;
  int turn = 0;
  int mood = -1;           // index into face.h MOODS
  uint32_t rate = 0;
  uint32_t samples = 0;
  int16_t* pcm = nullptr;  // points into data once parsed
  uint8_t* data = nullptr; // the request body, owned
  size_t bytes = 0;
  Frame* frames = nullptr; // owned
  uint32_t n = 0;
  Clip() = default;
  Clip(const Clip&) = delete;
  Clip& operator=(const Clip&) = delete;
  ~Clip() { free(data); free(frames); }
};

// WAV (RIFF, 16-bit PCM, mono, 8..48 kHz) → c.pcm/rate/samples, in place. Returns nullptr or the reason it can't play.
const char* parseWav(Clip& c);
// Builds c.frames: level from the samples; lips from the phonemes if any, else from the level alone.
bool buildTrack(Clip& c, const std::vector<Phone>* phones);
// Mouth at t seconds into the clip (interpolated), false outside the clip.
bool mouthAt(const Clip& c, float t, Mouth& out);
float levelAt(const Clip& c, float t);
// Is there a frame carrying `flag` in (a, b] seconds?
bool crossed(const Clip& c, uint8_t flag, float a, float b);

// Lips per frame from phonemes alone: analysis.js visemeTrack. vo/vw/vr/vt hold n floats each.
void visemeTrack(const std::vector<Phone>& phones, uint32_t n, float* vo, float* vw, float* vr, float* vt);
bool decodePhone(const std::string& utf8, uint16_t ms, Phone& out);
std::string urlDecode(const std::string& s);

}  // namespace eli
