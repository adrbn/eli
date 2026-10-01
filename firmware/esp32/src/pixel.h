// The Pixel family of faces on a 128x64 monochrome OLED: port of pixLit + oled() from web/js/themes.js.
// Pure C++ (no Arduino): checked against the JS on the host by test/.
#pragma once
#include <cstdint>
#include "face.h"

namespace eli {

constexpr int THEME_COUNT = 3;
extern const char* const THEMES[THEME_COUNT];  // "pixel", "blocs", "perles"
int themeIndex(const char* id);                // -1 if this board can't draw it

// Draws into a U8g2 full-frame buffer (SSD1306/SH1106 layout: 8 pages of 128 bytes, bit 0 = top row).
void renderFace(int theme, const FaceOut& f, uint8_t buf[1024]);

}  // namespace eli
