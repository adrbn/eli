#include "pixel.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace eli {

const char* const THEMES[THEME_COUNT] = {"pixel", "blocs", "perles"};

int themeIndex(const char* id) {
  for (int i = 0; i < THEME_COUNT; i++)
    if (!strcmp(id, THEMES[i])) return i;
  return -1;
}

// Signed distance to a rounded box (negative inside). Only its sign is used, so points outside the bounding
// rectangle return early: that skips the sqrt for ~95% of the screen.
static float sdBox(float px, float py, float bx, float by, float r) {
  if (fabsf(px) > bx || fabsf(py) > by) return 1;
  const float qx = fabsf(px) - bx + r, qy = fabsf(py) - by + r;
  return std::min(std::max(qx, qy), 0.0f) + hypotf(std::max(qx, 0.0f), std::max(qy, 0.0f)) - r;
}

static float clamp01(float v) { return std::min(1.0f, std::max(0.0f, v)); }

// themes.js pixLit: is the point (x ∈ [0, 2], y ∈ [0, 1]) lit?
static bool pixLit(const FaceOut& f, float x, float y, float minH) {
  const Eyes& e = f.eyes;
  const Mouth& m = f.mouth;
  const float hw = 0.2f * e.sc, hh = std::max(0.03f, 0.24f * e.sc * e.open), er = std::min(hw, hh) * 0.6f;
  for (int s = -1; s <= 1; s += 2) {
    const float ex = 1 + s * 0.4f + e.gx * 0.125f, ey = 0.38f + e.gy * 0.1f - e.bo * 0.0625f;
    if (sdBox(x - ex, y - ey, hw, hh, er) > 0) continue;
    // Slanted lid: angry, the inner corner drops; sad, the outer one.
    const float inner = clamp01((1 - s * (x - ex) / hw) / 2);
    if (e.ang != 0 && y - (ey - hh) < hh * (e.ang > 0 ? e.ang * 1.1f * inner : -e.ang * 0.9f * (1 - inner))) continue;
    const float sx = (x - ex) / (1.3f * hw), sy = (y - ey - 1.1f * hh) / (1.2f * hh * e.hap);
    const bool smile = e.hap > 0.05f && sx * sx + sy * sy <= 1;
    return !smile;
  }
  const float mw = 0.075f + m.w * 0.09f - m.r * 0.045f, mh = std::max(minH, 0.022f + m.o * 0.075f + m.r * 0.012f);
  const float dy = y - 0.82f;
  return sdBox(x - 1, dy, mw, mh, std::min(mw, mh) * (0.7f + m.r * 0.3f)) <= 0;  // one piece: no teeth line
}

// themes.js oled(cols, cell, pattern): a grid of cols x cols/2 cells of `cell` pixels, `pattern` = lit pixels per cell.
struct Grid { int cols, cell, npat; uint8_t pat[5][2]; };
static const Grid GRIDS[THEME_COUNT] = {
    {128, 1, 1, {{0, 0}}},
    {42, 3, 4, {{0, 0}, {1, 0}, {0, 1}, {1, 1}}},
    {32, 4, 5, {{1, 0}, {0, 1}, {1, 1}, {2, 1}, {1, 2}}},
};

void renderFace(int theme, const FaceOut& f, uint8_t buf[1024]) {
  memset(buf, 0, 1024);
  const Grid& g = GRIDS[theme >= 0 && theme < THEME_COUNT ? theme : 0];
  const int rows = g.cols / 2, x0 = (128 - g.cols * g.cell) >> 1, y0 = (64 - rows * g.cell) >> 1;
  const float minH = 0.55f / rows;
  for (int j = 0; j < rows; j++)
    for (int i = 0; i < g.cols; i++) {
      if (!pixLit(f, (i + 0.5f) / g.cols * 2, (j + 0.5f) / rows, minH)) continue;
      for (int p = 0; p < g.npat; p++) {
        const int x = x0 + i * g.cell + g.pat[p][0], y = y0 + j * g.cell + g.pat[p][1];
        if (x >= 0 && x < 128 && y >= 0 && y < 64) buf[(y >> 3) * 128 + x] |= 1 << (y & 7);
      }
    }
}

}  // namespace eli
