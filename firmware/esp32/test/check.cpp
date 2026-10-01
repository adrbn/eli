// Host build of the pure firmware modules (clip, face, pixel). Driven by check.mjs, which feeds the same inputs
// to the original web/js code and compares. Also asserts a few things on its own (WAV parsing, sleep, blinks).
#include <cassert>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <sstream>

#include "../src/clip.h"
#include "../src/face.h"
#include "../src/pixel.h"

using namespace eli;

static std::vector<uint8_t> wav(uint32_t rate, uint16_t channels, uint16_t bits, const std::vector<int16_t>& pcm, bool junk) {
  std::vector<uint8_t> b;
  auto u32 = [&](uint32_t v) { for (int i = 0; i < 4; i++) b.push_back(v >> (8 * i)); };
  auto u16 = [&](uint16_t v) { b.push_back(v & 255); b.push_back(v >> 8); };
  auto tag = [&](const char* t) { b.insert(b.end(), t, t + 4); };
  tag("RIFF"); u32(0); tag("WAVE");
  if (junk) { tag("LIST"); u32(3); b.push_back(1); b.push_back(2); b.push_back(3); b.push_back(0); }  // odd size + pad
  tag("fmt "); u32(16); u16(1); u16(channels); u32(rate); u32(rate * 2); u16(2); u16(bits);
  tag("data"); u32(pcm.size() * 2);
  for (int16_t s : pcm) u16(s);
  return b;
}

static const char* parse(std::vector<uint8_t> bytes, Clip& c) {
  c.bytes = bytes.size();
  c.data = static_cast<uint8_t*>(malloc(c.bytes));
  memcpy(c.data, bytes.data(), c.bytes);
  return parseWav(c);
}

static void nativeChecks() {
  std::vector<int16_t> pcm = {1, -2, 3, 32767, -32768};
  { Clip c; assert(!parse(wav(22050, 1, 16, pcm, true), c)); assert(c.rate == 22050 && c.samples == 5 && c.pcm[3] == 32767 && c.pcm[4] == -32768); }
  { Clip c; assert(parse(wav(22050, 2, 16, pcm, false), c)); }   // stereo refused
  { Clip c; assert(parse(wav(22050, 1, 8, pcm, false), c)); }    // 8-bit refused
  { Clip c; assert(parse(wav(4000, 1, 16, pcm, false), c)); }    // rate out of range
  { Clip c; auto b = wav(16000, 1, 16, pcm, false); b.resize(30); assert(parse(b, c)); }  // truncated
  { Clip c; assert(parse({'I', 'D', '3', 4, 0, 0, 0, 0, 0, 0, 0, 0}, c)); }               // an MP3
  { Clip c; auto b = wav(16000, 1, 16, pcm, false); b[40] = 0xFF; b[41] = b[42] = b[43] = 0xFF; assert(!parse(b, c) && c.samples == 5); }
  assert(urlDecode("%5B%5B%22a%22%2C40%5D%5D+%") == "[[\"a\",40]]+%");
  Phone p;
  assert(decodePhone("ɔ̃", 10, p) && p.count == 2 && p.cp == 0x254 && p.letter);
  assert(decodePhone("", 10, p) && p.count == 0);
  assert(!decodePhone("\xC3", 10, p));
  assert(moodIndex("colère") == 4 && moodIndex("x") == -1);
  assert(themeIndex("perles") == 2 && themeIndex("chat-pixel") == -1);

  // Behaviour: blinks while awake, falls asleep after ~3 min idle, wakes when spoken to.
  srand(1);
  Face face;
  Sense idle;
  bool blinked = false, asleep = false;
  for (int i = 0; i < 30 * 200; i++) {
    FaceOut f = face.update(1 / 30.0f, idle);
    if (i < 30 * 60 && f.eyes.open < 0.3f) blinked = true;
    asleep = f.asleep;
  }
  assert(blinked && asleep);
  Sense speak;
  speak.mode = Mode::Speak;
  speak.hasMouth = true;
  speak.mouth = {0.8f, 0.5f, 0, 0};
  face.wake();
  FaceOut f{};
  for (int i = 0; i < 30; i++) f = face.update(1 / 30.0f, speak);
  assert(!f.asleep && f.mouth.o == 0.8f);
}

int main(int argc, char** argv) {
  nativeChecks();
  if (argc < 2) return puts("native checks ok"), 0;
  std::ifstream in(argv[1]);
  std::string kind;
  std::vector<Phone> phones;
  while (in >> kind) {
    if (kind == "PCM") {  // PCM <raw int16 file> <rate>: level, phrase starts, pauses
      std::string path;
      uint32_t rate;
      in >> path >> rate;
      std::ifstream raw(path, std::ios::binary);
      std::vector<char> bytes((std::istreambuf_iterator<char>(raw)), {});
      Clip c;
      c.bytes = bytes.size();
      c.data = static_cast<uint8_t*>(malloc(c.bytes));
      memcpy(c.data, bytes.data(), c.bytes);
      c.pcm = reinterpret_cast<int16_t*>(c.data);
      c.samples = c.bytes / 2;
      c.rate = rate;
      buildTrack(c, nullptr);
      printf("LV");
      for (uint32_t i = 0; i < c.n; i++) printf(" %.5f", c.frames[i].lv);
      printf("\nFLAGS");
      for (uint32_t i = 0; i < c.n; i++) printf(" %d", c.frames[i].flags);
      printf("\n");
    } else if (kind == "PH") {  // PH <ms> <url-encoded phoneme>
      int ms;
      std::string enc;
      in >> ms >> enc;
      Phone p;
      if (!decodePhone(urlDecode(enc == "-" ? "" : enc), ms, p)) return fprintf(stderr, "bad phoneme %s\n", enc.c_str()), 1;
      phones.push_back(p);
    } else if (kind == "VISEMES") {  // VISEMES <n>
      uint32_t n;
      in >> n;
      std::vector<float> v(4 * n);
      visemeTrack(phones, n, &v[0], &v[n], &v[2 * n], &v[3 * n]);
      for (int k = 0; k < 4; k++) {
        printf("V%d", k);
        for (uint32_t i = 0; i < n; i++) printf(" %.5f", v[k * n + i]);
        printf("\n");
      }
    } else if (kind == "FACE") {  // FACE <theme> gx gy open hap sc bo ang o w r t
      std::string theme;
      FaceOut f{};
      in >> theme >> f.eyes.gx >> f.eyes.gy >> f.eyes.open >> f.eyes.hap >> f.eyes.sc >> f.eyes.bo >> f.eyes.ang >>
          f.mouth.o >> f.mouth.w >> f.mouth.r >> f.mouth.t;
      uint8_t buf[1024];
      renderFace(themeIndex(theme.c_str()), f, buf);
      printf("BMP ");
      for (int y = 0; y < 64; y++)
        for (int x = 0; x < 128; x++) putchar(buf[(y >> 3) * 128 + x] >> (y & 7) & 1 ? '1' : '0');
      printf("\n");
    }
  }
  return 0;
}
