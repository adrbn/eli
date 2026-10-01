// The face's behaviour: gaze, blinks, gestures, moods, sleep. Port of web/js/face.js; draws nothing.
// Pure C++ (no Arduino): checked on the host by test/.
#pragma once
#include "clip.h"

namespace eli {

enum class Mode : uint8_t { Idle, Listen, Think, Speak, Sing };

struct Eyes { float gx, gy, open, hap, sc, bo, ang; };
struct FaceOut { bool asleep; Eyes eyes; Mouth mouth; };

// What the face perceives this frame (main.js sense()).
struct Sense {
  Mode mode = Mode::Idle;
  bool hasMouth = false;
  Mouth mouth{};
  bool hasGaze = false;
  float gazeX = 0, gazeY = 0;
  bool phraseStart = false, pause = false, clipEnd = false;
  float sway = 0, energy = 0, micLevel = 0;  // sing: no beat/pitch tracking on the board
};

struct Mood { const char* name; float hap, sc, sq, ang, ty, tx, bounce, pulse; Mouth rest; };
extern const Mood MOODS[];
int moodIndex(const std::string& name);  // -1 if unknown

class Face {
 public:
  int mood = -1;  // set by the caller while a clip carrying X-Mood plays
  void wake();
  FaceOut update(float dt, const Sense& s);

 private:
  enum Gesture { NONE, GLANCE, LOOKAROUND, DOUBLEBLINK, SMILE, CURIOUS, HUM, SIGH, YAWN };
  struct { float gx = 0, gy = 0, tx = 0, ty = 0, bl = 0, bt = 0, nb = 1.5f, hap = 0, sc = 1, bo = 0, sa = 0, av = 0,
           sq = 0, sleep = 0, ang = 0; } e;
  Mouth m{0, 0.3f, 0, 0};
  float T = 0, idle = 0, nextG = 5;
  struct { Gesture name = NONE; float t = 0, dur = 0, side = 1; } g;

  void blink();
  void pickGesture(float drowsy);
  bool gesture(float dt, Mouth& out);
  void relax(float dt, float scale);
  void saccade(float dt, Mode mode);
};

}  // namespace eli
