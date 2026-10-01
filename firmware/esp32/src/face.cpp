#include "face.h"

#include <algorithm>
#include <cmath>

namespace eli {

static const Mouth REST = {0, 0.3f, 0, 0};
constexpr float DROWSY_AFTER = 120;  // s with nothing going on → drowsy, asleep a minute later
constexpr float BREATH = 4.5f;       // s per sleeping breath
constexpr float PI_F = 3.14159265f;

static float clampf(float v, float a, float b) { return std::min(b, std::max(a, v)); }
static float ease(float a, float b, float k, float dt) { return a + (b - a) * (1 - expf(-k * dt)); }
static float bell(float u) { return sinf(PI_F * clampf(u, 0, 1)); }
static float rnd() { return (float)rand() / ((float)RAND_MAX + 1.0f); }

//                         name         hap   sc    sq    ang   ty    tx    bounce pulse  rest {o, w, r, t}
const Mood MOODS[] = {
    {"joie",      0.85f, 1.06f, 0,     0,     0,     0,     0,    0,     {0.04f, 0.75f, 0, 0}},
    {"rire",      1,     1.04f, 0,     0,     0,     0,     0.5f, 0,     {0.3f, 0.7f, 0.1f, 1}},
    {"surprise",  0,     1.25f, 0,     0,     0,     0,     0,    0,     {0.4f, 0.15f, 1, 0}},
    {"tristesse", 0,     0.94f, 0.25f, -0.9f, 0.35f, 0,     0,    0,     {0.03f, 0.15f, 0.4f, 0}},
    {"colère",    0,     0.95f, 0.3f,  1,     0,     0,     0,    0,     {0.05f, 0.45f, 0, 1}},
    {"amour",     0.75f, 1.08f, 0,     0,     0,     0,     0,    0.07f, {0.03f, 0.5f, 0.3f, 0}},
    {"malice",    0.45f, 1,     0,     0.45f, 0,     0.45f, 0,    0,     {0.03f, 0.5f, 0, 0}},
    {"gêne",      0.35f, 0.93f, 0,     0,     0.3f,  -0.6f, 0,    0,     {0.02f, 0.2f, 0.2f, 0}},
};
constexpr int MOOD_COUNT = sizeof(MOODS) / sizeof(MOODS[0]);

int moodIndex(const std::string& name) {
  for (int i = 0; i < MOOD_COUNT; i++)
    if (name == MOODS[i].name) return i;
  return -1;
}

void Face::blink() {
  e.bt = 0.17f;
  e.nb = 2.2f + rnd() * 3.8f;
}

void Face::wake() {
  if (e.sleep > 0.3f) {  // startled awake: wide eyes, then they settle
    blink();
    e.sc = 1.3f;
  }
  idle = 0;
  g.name = NONE;
}

void Face::pickGesture(float drowsy) {
  // [gesture, duration s, weight]; the cat-only meow is left out.
  const struct { Gesture name; float dur, w; } table[] = {
      {GLANCE, 2.2f, 4}, {LOOKAROUND, 3, 2}, {DOUBLEBLINK, 0.6f, 3}, {SMILE, 1.8f, 2}, {CURIOUS, 1.6f, 2},
      {HUM, 3.5f, 1.5f}, {SIGH, 1.8f, 1}, {YAWN, 3, (idle > 50 ? 1.5f : 0) + 8 * drowsy},
  };
  float total = 0;
  for (const auto& x : table) total += x.w;
  float r = rnd() * total;
  size_t i = 0;
  while (i + 1 < sizeof(table) / sizeof(table[0]) && (r -= table[i].w) >= 0) i++;
  g.name = table[i].name;
  g.t = 0;
  g.dur = table[i].dur * (0.85f + rnd() * 0.35f);
  g.side = rnd() < 0.5f ? -1 : 1;
  nextG = 5 + rnd() * 11 - drowsy * 3;
  if (g.name == DOUBLEBLINK) blink();
}

// The current gesture pushes gaze, mood and mouth; true (and the mouth in `out`) if it wants the mouth.
bool Face::gesture(float dt, Mouth& out) {
  const float u = g.t / g.dur, side = g.side;
  const Gesture name = g.name;
  g.t += dt;
  if (g.t >= g.dur) g.name = NONE;
  e.av = 0.2f;  // no saccade on top
  switch (name) {
    case GLANCE: e.tx = side * 1.05f; e.ty = -0.15f; return false;
    case LOOKAROUND: e.tx = u < 0.33f ? -side : u < 0.66f ? side : 0; e.ty = u < 0.66f ? -0.2f : 0; return false;
    case DOUBLEBLINK: if (g.t > 0.3f && g.t - dt <= 0.3f) blink(); return false;
    case SMILE: e.hap = std::max(e.hap, bell(u)); out = {0.04f, 0.3f + 0.6f * bell(u), 0, 0}; return true;
    case CURIOUS:
      e.sc = std::max(e.sc, 1 + 0.18f * bell(u)); e.tx = side * 0.5f; e.ty = -0.6f;
      if (g.t < dt * 1.5f) e.bo = 0.6f;
      return false;
    case HUM:
      e.hap = std::max(e.hap, 0.6f * bell(u)); e.tx = 0.3f * sinf(T * 3);
      out = {0.08f + 0.1f * fabsf(sinf(T * 7)), 0.35f, 0.5f, 0};
      return true;
    case SIGH:
      e.sq = std::max(e.sq, 0.5f * bell(u)); e.sc = std::min(e.sc, 1 - 0.06f * bell(u)); e.ty = 0.25f;
      out = {0.18f * bell(u * 1.4f), 0.25f, 0.6f, 0};
      return true;
    case YAWN:
      e.sq = std::max(e.sq, 0.85f * bell(u * 1.1f)); e.sc = std::max(e.sc, 1 + 0.05f * bell(u)); e.ty = -0.25f;
      if (g.name == NONE) blink();
      out = {0.95f * powf(bell(u * 1.15f), 0.7f), 0.2f, 0.35f * bell(u), 0};
      return true;
    default: return false;
  }
}

void Face::relax(float dt, float scale) {
  const Mood* md = mood >= 0 && mood < MOOD_COUNT ? &MOODS[mood] : nullptr;
  e.hap = ease(e.hap, md ? md->hap : 0, 6, dt);
  e.sc = ease(e.sc, scale * (md ? md->sc : 1), 6, dt);
  e.sq = ease(e.sq, md ? md->sq : 0, 6, dt);
}

void Face::saccade(float dt, Mode mode) {
  e.av -= dt;
  e.sa -= dt;
  if (e.av > 0 || e.sa > 0) return;
  const float amp = mode == Mode::Listen ? 0.18f : mode == Mode::Idle ? 0.5f : 0.3f;
  e.tx = (rnd() - 0.5f) * amp;
  e.ty = (rnd() - 0.5f) * amp * 0.6f;
  e.sa = mode == Mode::Listen ? 0.9f + rnd() * 1.1f : mode == Mode::Idle ? 0.8f + rnd() * 2.5f : 0.35f + rnd() * 1.1f;
}

FaceOut Face::update(float dt, const Sense& s) {
  T += dt;
  idle = s.mode == Mode::Idle ? idle + dt : 0;
  const float drowsy = clampf((idle - DROWSY_AFTER) / 60, 0, 1);
  e.sleep = ease(e.sleep, drowsy, drowsy < e.sleep ? 6 : 0.8f, dt);
  const bool asleep = e.sleep > 0.6f;
  if (s.mode == Mode::Idle && !asleep) {
    nextG -= dt;
    if (g.name == NONE && nextG <= 0 && idle > 3) pickGesture(drowsy);
  } else {
    g.name = NONE;
  }

  if (s.clipEnd) {  // end of a line: hand the floor back by looking at the other person
    e.tx = 0;
    e.ty = 0;
    e.av = 0;
    if (rnd() < 0.6f) blink();
  }
  Mouth gm;
  bool hasGm = false;
  switch (s.mode) {
    case Mode::Speak:
      if (s.phraseStart && rnd() < 0.75f) {
        e.tx = (rnd() < 0.5f ? -1 : 1) * 0.6f;
        e.ty = -0.45f;
        e.av = 0.5f + rnd() * 0.35f;
      }
      if (s.pause && rnd() < 0.4f) blink();
      relax(dt, 1);
      break;
    case Mode::Sing:  // no vocal line or pitch here: sway, happy eyes, eyes swell with the energy
      e.tx = 0.4f * sinf(s.sway);
      e.ty = -0.1f;
      e.av = 0;
      e.hap = ease(e.hap, 1, 5, dt);
      e.sc = ease(e.sc, 1 + 0.06f * s.energy, 6, dt);
      e.sq = ease(e.sq, 0, 6, dt);
      break;
    case Mode::Listen:
      relax(dt, 1.1f + 0.12f * s.micLevel);
      if (fmodf(T, 3.2f) < dt) e.bo = std::max(e.bo, 0.45f);  // little nods
      break;
    case Mode::Think:
      e.tx = 0.5f * sinf(T * 1.3f);
      e.ty = -0.55f;
      e.av = 0.3f;
      e.hap = ease(e.hap, 0, 6, dt);
      e.sc = ease(e.sc, 1, 4, dt);
      e.sq = ease(e.sq, 0.35f, 4, dt);
      break;
    case Mode::Idle:
      relax(dt, 1);
      if (g.name != NONE) hasGm = gesture(dt, gm);
      break;
  }

  if (s.mode != Mode::Sing && s.mode != Mode::Think && !asleep) saccade(dt, s.mode);
  if (!asleep) {
    e.nb -= dt;
    if (e.nb <= 0) blink();
  }
  if (e.bt > 0) {
    e.bt -= dt;
    const float q = 1 - std::max(0.0f, e.bt) / 0.17f;
    e.bl = q < 0.4f ? q / 0.4f : 1 - (q - 0.4f) / 0.6f;
  } else {
    e.bl = 0;
  }
  e.bo *= expf(-dt * 7);

  const Mood* md = !asleep && mood >= 0 && mood < MOOD_COUNT ? &MOODS[mood] : nullptr;
  e.ang = ease(e.ang, md ? md->ang : 0, 6, dt);
  if (md && md->bounce && fmodf(T, 0.32f) < dt) e.bo = std::max(e.bo, md->bounce);  // laughing: little hops
  const float pulse = md && md->pulse ? md->pulse * powf(std::max(0.0f, sinf(T * 7.5f)), 8) : 0;  // love: heartbeat

  const float phase = fmodf(T / BREATH, 1), inhale = asleep && phase < 0.4f ? bell(phase / 0.4f) : 0;
  const Mouth sleepy = {0.05f + 0.17f * inhale, 0.25f, 0.4f, 0};
  const Mouth want = hasGm ? gm : asleep ? sleepy : md ? md->rest : REST;
  if (s.hasMouth && md) {  // the mood pulls the speaking mouth: wider with joy, rounder with surprise
    m = s.mouth;
    m.w = clampf(s.mouth.w + (md->rest.w - 0.3f) * 0.5f, 0, 1);
    m.r = clampf(s.mouth.r + md->rest.r * 0.3f, 0, 1);
  } else if (s.hasMouth) {
    m = s.mouth;
  } else {
    const float k = hasGm ? 12 : 20;
    m = {ease(m.o, want.o, k, dt), ease(m.w, want.w, k, dt), ease(m.r, want.r, k, dt), ease(m.t, want.t, k, dt)};
  }

  const float gx = s.hasGaze ? s.gazeX : 0, gy = s.hasGaze ? s.gazeY : 0, gk = s.mode == Mode::Sing ? 8 : 20;
  e.gx = ease(e.gx, clampf(gx + e.tx + (md ? md->tx : 0), -1.3f, 1.3f), gk, dt);
  e.gy = ease(e.gy, clampf(gy + e.ty + (md ? md->ty : 0) + e.sleep * 0.3f, -1, 1), gk, dt);
  const float breathe = asleep ? 0.03f * inhale : 0.008f * sinf(T * 1.6f);  // awake, it barely breathes
  const float open = (1 - e.bl * 0.93f) * (1 - e.sq * 0.4f) * (1 - e.sleep * 0.9f);
  return {asleep, {e.gx, e.gy, open, e.hap, e.sc + breathe + pulse, e.bo, e.ang}, m};
}

}  // namespace eli
