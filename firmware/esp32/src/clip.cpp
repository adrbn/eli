#include "clip.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#ifdef ARDUINO
#include <esp_heap_caps.h>
#endif

namespace eli {

void* bigAlloc(size_t n) {
#ifdef ARDUINO
  void* p = heap_caps_malloc(n, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  return p ? p : malloc(n);
#else
  return malloc(n);
#endif
}

static float clampf(float v, float a = 0, float b = 1) { return std::min(b, std::max(a, v)); }
static uint16_t le16(const uint8_t* p) { return p[0] | p[1] << 8; }
static uint32_t le32(const uint8_t* p) { return p[0] | p[1] << 8 | p[2] << 16 | (uint32_t)p[3] << 24; }

const char* parseWav(Clip& c) {
  const uint8_t* d = c.data;
  const size_t len = c.bytes;
  if (!d || len < 12 || memcmp(d, "RIFF", 4) || memcmp(d + 8, "WAVE", 4)) return "not a WAV file";
  uint16_t format = 0, channels = 0, bits = 0;
  uint32_t rate = 0;
  bool fmt = false;
  for (size_t pos = 12; pos + 8 <= len;) {
    const uint8_t* body = d + pos + 8;
    const size_t avail = len - pos - 8;
    size_t size = le32(d + pos + 4);
    if (!memcmp(d + pos, "fmt ", 4)) {
      if (size < 16 || avail < 16) return "bad fmt chunk";
      format = le16(body);
      channels = le16(body + 2);
      rate = le32(body + 4);
      bits = le16(body + 14);
      if (format == 0xFFFE && size >= 26 && avail >= 26) format = le16(body + 24);  // WAVE_FORMAT_EXTENSIBLE
      fmt = true;
    } else if (!memcmp(d + pos, "data", 4)) {
      if (!fmt) return "data chunk before fmt";
      if (format != 1 || bits != 16) return "need 16-bit PCM";
      if (channels != 1) return "need mono";
      if (rate < 8000 || rate > 48000) return "sample rate must be 8..48 kHz";
      if (size == 0 || size > avail) size = avail;  // streamed WAVs leave the size at 0 or 0xFFFFFFFF
      if (size < 2) return "no samples";
      memmove(c.data, body, size & ~(size_t)1);  // PCM to the start of the buffer: aligned for int16_t
      c.pcm = reinterpret_cast<int16_t*>(c.data);
      c.samples = size / 2;
      c.rate = rate;
      return nullptr;
    }
    if (size > avail) break;
    pos += 8 + size + (size & 1);
  }
  return "no data chunk";
}

// ---- level: analysis.js rmsDb + the level part of analyzeSpeech ----------------------------------------------
static float rmsDb(const int16_t* x, uint32_t len, long c, long half) {
  float s = 0;
  long k = 0;
  for (long i = std::max(0L, c - half); i < std::min((long)len, c + half); i++, k++) {
    const float v = x[i] / 32768.0f;
    s += v * v;
  }
  return 10 * log10f(s / std::max(1L, k) + 1e-12f);
}

static void levels(const Clip& c, float* lv) {
  const float step = c.rate * HOP;
  const long half = lroundf(step);
  std::vector<float> db(c.n), loud;
  for (uint32_t f = 0; f < c.n; f++) {
    db[f] = rmsDb(c.pcm, c.samples, lroundf(f * step), half);
    if (db[f] > -55) loud.push_back(db[f]);
  }
  float ref = 0;  // 95th percentile of the non-silent frames
  if (!loud.empty()) {
    const size_t i = std::min(loud.size() - 1, (size_t)(0.95 * loud.size()));
    std::nth_element(loud.begin(), loud.begin() + i, loud.end());
    ref = loud[i];
  }
  for (uint32_t f = 0; f < c.n; f++) lv[f] = db[f] < -55 || db[f] < ref - 34 ? 0 : clampf((db[f] - (ref - 32)) / 28);
}

// ---- visemes: analysis.js VISEMES + visemeTrack ---------------------------------------------------------------
struct Viseme { const char* chars; float v[4]; };
static const Viseme VISEMES[] = {
    {"aɑɐæʌ", {1, 0.55f, 0, 0}},    {"ɛeɜɚ", {0.6f, 0.8f, 0, 0.2f}},  {"iɪj", {0.3f, 1, 0, 0.4f}},
    {"əœøɵ", {0.45f, 0.35f, 0.5f, 0}}, {"y", {0.2f, 0.1f, 0.9f, 0}},  {"uʊwɥ", {0.22f, 0, 1, 0}},
    {"oɔɒ", {0.6f, 0.2f, 0.8f, 0}},  {"mbp", {0, 0.45f, 0, 0}},       {"fv", {0.08f, 0.5f, 0, 1}},
    {"szθð", {0.15f, 0.75f, 0, 1}},  {"ʃʒ", {0.25f, 0.2f, 0.75f, 0.8f}}, {"tdnlɾ", {0.25f, 0.55f, 0, 0.4f}},
    {"kgɡŋʁɹhxχ", {0.35f, 0.45f, 0.1f, 0}}, {"ɲ", {0.25f, 0.6f, 0, 0.2f}},
};
static const float LETTER[4] = {0.3f, 0.4f, 0, 0};  // a letter not in the table
static const float REST4[4] = {0, 0.3f, 0, 0};
constexpr uint32_t LEAD_MS = 40;  // lips move a little before the sound (and the springs take ~2/k to follow)

// A muscle, not a magnet: critically damped spring solved exactly over one 10 ms step. It starts gently and lands
// without overshoot, where plain smoothing starts at full speed and makes the mouth jump. k: stiffness (rad/s).
struct Spring {
  float x, v = 0;
  float to(float target, float k) {
    const float e = x - target, j = (v + k * e) * 0.01f, d = expf(-k * 0.01f);
    x = target + (e + j) * d;
    v = (v - k * j) * d;
    return x;
  }
};

// Next code point of UTF-8 text at *p (advances p), or -1 if malformed.
static long nextCp(const unsigned char*& p, const unsigned char* end) {
  const unsigned c = *p++;
  int more = c < 0x80 ? 0 : (c >> 5) == 6 ? 1 : (c >> 4) == 14 ? 2 : (c >> 3) == 30 ? 3 : -1;
  if (more < 0 || end - p < more) return -1;
  long cp = more == 0 ? c : more == 1 ? c & 0x1F : more == 2 ? c & 0x0F : c & 0x07;
  while (more--) {
    if ((*p & 0xC0) != 0x80) return -1;
    cp = cp << 6 | (*p++ & 0x3F);
  }
  return cp;
}

// \p{L} for the scripts phonemizers emit: Latin, IPA, spacing modifier letters, Greek.
static bool isLetter(uint32_t c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == 0xAA || c == 0xB5 || c == 0xBA ||
         (c >= 0xC0 && c <= 0x2C1 && c != 0xD7 && c != 0xF7) || (c >= 0x2C6 && c <= 0x2D1) ||
         (c >= 0x2E0 && c <= 0x2E4) || c == 0x2EC || c == 0x2EE || (c >= 0x370 && c <= 0x3FF && c != 0x37E && c != 0x387);
}

bool decodePhone(const std::string& utf8, uint16_t ms, Phone& out) {
  out = {0, 0, false, ms};
  auto p = reinterpret_cast<const unsigned char*>(utf8.data());
  const auto end = p + utf8.size();
  while (p < end) {
    const long cp = nextCp(p, end);
    if (cp < 0 || out.count == 8) return false;
    if (out.count++ == 0) out.cp = cp;
    out.letter = out.letter || isLetter(cp);
  }
  return true;
}

static const float* visemeOf(const Phone& ph) {
  if (ph.count == 1) {
    for (const Viseme& v : VISEMES) {
      auto p = reinterpret_cast<const unsigned char*>(v.chars);
      const auto end = p + strlen(v.chars);
      while (p < end)
        if (nextCp(p, end) == (long)ph.cp) return v.v;
    }
  }
  return ph.letter ? LETTER : nullptr;
}

void visemeTrack(const std::vector<Phone>& phones, uint32_t n, float* vo, float* vw, float* vr, float* vt) {
  struct Span { const Phone* p; const float* v; uint32_t start, end; };  // ms: frames and phonemes align exactly
  std::vector<Span> spans;
  spans.reserve(phones.size());
  uint32_t t = 0;
  for (const Phone& ph : phones) {
    const uint32_t start = t;
    t += ph.ms;
    spans.push_back({&ph, visemeOf(ph), start, t});
  }
  const auto is = [](const Span& s, uint32_t cp) { return s.p->count == 1 && s.p->cp == cp; };
  for (size_t i = 0; i < spans.size(); i++)  // length (ː) and nasal tilde belong to the phoneme before
    if (is(spans[i], 0x2D0) || is(spans[i], 0x303)) spans[i].v = i ? spans[i - 1].v : nullptr;
  for (size_t i = spans.size(); i-- > 0;)  // stress marks belong to the phoneme after
    if (is(spans[i], 0x2C8) || is(spans[i], 0x2CC)) spans[i].v = i + 1 < spans.size() ? spans[i + 1].v : nullptr;
  size_t k = 0;
  Spring o{0}, w{0.3f}, r{0}, th{0};
  for (uint32_t f = 0; f < n; f++) {
    const uint32_t at = f * 10 + LEAD_MS;
    while (k + 1 < spans.size() && spans[k].end <= at) k++;
    const float* v = k < spans.size() && at >= spans[k].start && at < spans[k].end ? spans[k].v : nullptr;
    if (!v) v = REST4;
    vo[f] = o.to(v[0], v[0] < 0.05f ? 110 : 70);  // closures (m, b, p) snap shut
    vw[f] = w.to(v[1], 45);
    vr[f] = r.to(v[2], 38);  // rounding the lips is the slowest move
    vt[f] = th.to(v[3], 50);
  }
}

bool buildTrack(Clip& c, const std::vector<Phone>* phones) {
  c.n = std::max<uint32_t>(1, (uint32_t)ceilf(c.samples / (c.rate * HOP)));
  c.frames = static_cast<Frame*>(bigAlloc(sizeof(Frame) * c.n));
  std::vector<float> lv(c.n);
  if (!c.frames) return false;
  levels(c, lv.data());
  if (phones && !phones->empty()) {  // lip shapes from the phonemes, amplitude from the sound (mouthAt)
    std::vector<float> v(4 * c.n);
    visemeTrack(*phones, c.n, &v[0], &v[c.n], &v[2 * c.n], &v[3 * c.n]);
    for (uint32_t f = 0; f < c.n; f++)
      c.frames[f].m = {v[f] * (0.55f + 0.45f * lv[f]), v[c.n + f], v[2 * c.n + f], v[3 * c.n + f]};
  } else {
    // ponytail: no spectrum, so the formant cues of analyzeSpeech sit at mid-range (open/width follow the level
    // only, no rounding or teeth). Port its FFT bands (esp-dsp) if phoneme-less voices look too flat.
    float so = 0, sw = 0.3f;
    for (uint32_t f = 0; f < c.n; f++) {
      const float level = lv[f];
      const float to = level ? powf(level, 0.8f) * 0.675f : 0, tw = level ? 0.625f : 0.3f;
      so += (to - so) * (to > so ? 0.6f : to == 0 ? 0.7f : 0.45f);
      sw += (tw - sw) * 0.35f;
      c.frames[f].m = {so, sw, 0, 0};
    }
  }
  for (uint32_t f = 0, quiet = 25; f < c.n; f++) {  // 250 ms of silence = a pause; sound after it = a phrase start
    c.frames[f].lv = lv[f];
    c.frames[f].flags = 0;
    if (lv[f] == 0) {
      if (++quiet == 25) c.frames[f].flags |= F_PAUSE;
    } else {
      if (quiet >= 25) c.frames[f].flags |= F_START;
      quiet = 0;
    }
  }
  return true;
}

// analysis.js sample(): linear interpolation between frames.
template <typename Get>
static float sampleAt(const Clip& c, float t, Get get) {
  const float f = t / HOP;
  if (f <= 0) return get(c.frames[0]);
  const uint32_t i = (uint32_t)f;
  if (i >= c.n - 1) return get(c.frames[c.n - 1]);
  const float k = f - i;
  return get(c.frames[i]) * (1 - k) + get(c.frames[i + 1]) * k;
}

bool mouthAt(const Clip& c, float t, Mouth& out) {
  if (!c.frames || t < 0 || t > c.n * HOP) return false;
  out = {sampleAt(c, t, [](const Frame& f) { return f.m.o; }), sampleAt(c, t, [](const Frame& f) { return f.m.w; }),
         sampleAt(c, t, [](const Frame& f) { return f.m.r; }), sampleAt(c, t, [](const Frame& f) { return f.m.t; })};
  return true;
}

float levelAt(const Clip& c, float t) {
  return c.frames ? sampleAt(c, clampf(t, 0, c.n * HOP), [](const Frame& f) { return f.lv; }) : 0;
}

bool crossed(const Clip& c, uint8_t flag, float a, float b) {
  if (!c.frames || b <= a) return false;
  const long from = std::max(0L, (long)floorf(a / HOP)), to = std::min((long)c.n - 1, (long)floorf(b / HOP) + 1);
  for (long f = from; f <= to; f++)
    if ((c.frames[f].flags & flag) && f * HOP > a && f * HOP <= b) return true;
  return false;
}

std::string urlDecode(const std::string& s) {
  std::string out;
  out.reserve(s.size());
  const auto hex = [](char h) { return h >= '0' && h <= '9' ? h - '0' : h >= 'a' && h <= 'f' ? h - 'a' + 10 : h >= 'A' && h <= 'F' ? h - 'A' + 10 : -1; };
  for (size_t i = 0; i < s.size(); i++) {
    const int hi = s[i] == '%' && i + 2 < s.size() ? hex(s[i + 1]) : -1, lo = hi >= 0 ? hex(s[i + 2]) : -1;
    if (lo >= 0) {
      out += static_cast<char>(hi << 4 | lo);
      i += 2;
    } else {
      out += s[i];  // like Python's unquote: a stray % stays, '+' stays '+'
    }
  }
  return out;
}

}  // namespace eli
