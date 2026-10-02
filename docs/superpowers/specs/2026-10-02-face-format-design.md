# Face format (`.eliface`): design

Date: 2026-10-02. Status: approved in conversation, to be planned.

## Why

Eli's faces are hand-written JavaScript (`web/js/themes.js`), and only three of them are hand-ported to the ESP32
(`firmware/esp32/src/pixel.cpp`). A community catalog needs faces that anyone can share as a file and that run
everywhere: the web page, the macOS app and the ESP32, without code and without reflashing.

## Goals

- One declarative file describes a face: shapes whose sizes and positions are formulas of the face state.
- One evaluator, in JS and in C++, gives the same pixels on both sides.
- Every display (OLED grid, beads, custom grid, round matrix, vector) can show every face.
- The ESP32 receives a face at runtime from the server and shows it at once.
- **Acceptance**: Pixel, Chat pixel and Matrice rebuilt in the format give **0 differing pixels** against the current
  code over a sweep of thousands of states, in JS and in C++.

## Non-goals (this spec)

- The visual editor (a later pass writes the same files).
- The registry, gallery and `.elimod` sharing (next spec).
- Time-based shape animation beyond what formulas of `T` give. `oscillo` stays code.
- Removing the current code: it stays as the backup and the reference for the comparison.

## 1. The file

JSON, extension `.eliface`, at most 16 KB, 64 shapes after mirroring and 32 `vars`.

```json
{
  "format": 1,
  "id": "pixel",
  "name": "Pixel",
  "author": "adrbn",
  "license": "MIT",
  "display": "oled",
  "space": "wide",
  "vars": {
    "hw": "0.2*sc",
    "hh": "max(0.03, 0.24*sc*open)",
    "ex": "1 + s*0.4 + gx*0.125",
    "ey": "0.38 + gy*0.1 - bo*0.0625"
  },
  "shapes": [
    { "mirror": true, "group": [
      { "rect": ["ex", "ey", "hw", "hh"], "radius": "min(hw, hh)*0.6" },
      { "cut": { "ellipse": ["ex", "ey + 1.1*hh", "1.3*hw", "1.2*hh*hap"] }, "when": "hap > 0.05" }
    ]}
  ],
  "anchors": { "exL": "0.6 + gx*0.125", "exR": "1.4 + gx*0.125", "ey": "0.38 + gy*0.1 - bo*0.0625",
               "ew": "0.2*sc", "eh": "0.24*sc", "crown": "0.38 + gy*0.1 - bo*0.0625 - 0.24*sc - 0.02", "hw": 0.82 }
}
```

### Space and frame

- `"space": "wide"` (default): the current 2:1 frame, x in [0, 2], y in [0, 1], y down.
- `"space": "square"`: x and y in [-1, 1], for faces designed for the round matrix.
- `"frame": [k, ox, oy]` (optional): the face is written in its own units (for the vector faces, the 220×220 box of
  `vector()`); a point (x, y) of the wide space is the author point (k·x + ox, k·y + oy). Without `frame`, author
  units are the space's units.
- `"shift": [fx, fy]` (optional formulas): added to the sample point before any test, once per pixel (the cat's
  `y = y0 + bo*0.04`).

A display maps its cells into the face's space: a square face on a wide grid uses `u = (x - 1) * 2, v = y * 2 - 1`;
a wide face on the square matrix uses `x = 1 + u / 2, y = (v + 1) / 2`.

### Variables available to formulas

| Name | Meaning |
| --- | --- |
| `gx gy open hap sc bo ang` | eyes: gaze, openness, smile, scale, bounce, eyelid angle (`f.eyes`) |
| `w o r t` | mouth: width, opening, roundness, teeth (`f.mouth`) |
| `T` | seconds since start (`f.T`) |
| `minH` | the display's minimum visible height (0.55 / rows) |
| `rows` | `round(0.55 / minH)`, for grid-aware patterns |
| `s` | -1 or +1 inside a `mirror` group, 1 elsewhere |
| `x y` | the sample point (author units, after `shift`): only in `region` formulas |
| any name in `vars` | evaluated in order once per frame for s = 1 and once for s = -1; a var may use earlier vars, never `x y` |

### Formulas

A string (or a plain number). Grammar: numbers, names, `+ - * /`, unary `-` and `!`, `< <= > >= == !=`, `&& ||`,
`a ? b : c`, parentheses, the constant `pi`, functions `min max clamp abs floor mod sin cos hypot sqrt sq box`. `mod` is the truncated
remainder (JS `%`, C `fmod`), `sq(a)` is `a ** 2`, `box(px, py, bx, by, r)` is the rounded-box SDF `sdBox`. Every
operand is evaluated (no short-circuit): formulas have no side effects. No loops, no assignment, no access to anything
outside the variables: a face cannot run code. Unknown names, unknown functions, wrong arity and syntax errors are
rejected when the file is compiled, with the field's path in the message.

### Shapes

Each shape is one primitive, plus optional modifiers. Numbers are formulas.

| Primitive | Arguments | Inside when |
| --- | --- | --- |
| `rect` | `[cx, cy, halfW, halfH]`, `radius` | `box(x - cx, y - cy, halfW, halfH, radius) <= 0` |
| `ellipse` | `[cx, cy, rx, ry]` | `sq((x - cx)/rx) + sq((y - cy)/ry) <= 1` |
| `segment` | `[ax, ay, bx, by]`, `stroke` | distance to the segment < stroke (same `segDist` as today) |
| `triangle` | `[ax, ay, bx, by, cx, cy]` | same `inTri` as today |
| `arc` | `[cx, cy, r, a0, a1]`, `stroke` | `abs(hypot(x - cx, y - cy) - r) < stroke` and the angle (canvas convention, radians) in [a0, a1] |
| `region` | a formula of `x y` | the formula is not 0 |

Primitives draw as paths on the vector display; a `region` (or a shape clipped by one) is sampled there on a fine grid.

Modifiers:

- `stroke`: on `rect` and `ellipse`, an outline of half thickness `stroke`: `abs(box(...)) < stroke` for `rect`,
  `abs(d - 1) * min(rx, ry) < stroke` with `d = hypot((x - cx)/rx, (y - cy)/ry)` for `ellipse` (the cat's head);
  required on `segment` and `arc`.
- `cut`: paints "off" (black on the vector display) instead of "on".
- `when`: a formula; the shape is skipped when it is 0.
- `clip`: `{ "inside": <shape> }` or `{ "outside": <shape> }`; the shape only counts where the clip holds.
- `dots`: inside the shape, the pixel is decided by the checkerboard `(floor(x/2*rows*2) + floor(y*rows)) % 2 == 0`
  (on) or off (the cat's cheeks and inner ears); drawn at alpha 0.3 on the vector display.
- `color`: a `#rrggbb` color; absent means the ink chosen in the app. v1 shows colors on the vector display; the
  grids (OLED, LED, matrix) light every shape whose luminance is > 0.2 in the app's ink (colored LEDs come with the
  gallery).
- `level`: intensity 0..1 (default 1): alpha on the vector and LED displays; on monochrome grids, < 0.75 dithers with
  the `dots` checkerboard.
- `mirror: true` with `group`: the group is emitted twice, first with `s = 1`, then with `s = -1`, so that under the
  painter's rule the `s = -1` copy wins, like the `for (const s of [-1, 1])` loops with early returns.

### Order

Painter's rule: shapes are tested from the **last** to the first; the first one whose test holds decides the pixel
(on with its color and level, off for `cut`, the checkerboard for `dots`). This reproduces the early `return`s of
`pixLit`, `catLit` and `matLit` by listing their tests in reverse.

### Anchors

`anchors` gives, as formulas in the wide space, the fields `looks.js` already reads: `exL exR ey ew eh crown hw`
(the eyes' centers, their half sizes, the top of the head, the head's half width). They feed `drawExtras` as
`{ ex: [exL, exR], ey, ew, eh, crown, hw }`, so outfits fit any face. Missing anchors fall back to `pixAnchors`.

## 2. Evaluator and displays (web)

- `web/js/faceexpr.js`: the formula language (parse to a stack program, run it). Pure.
- `web/js/faceformat.js`: pure, no DOM:
  - `compileFace(text) → Face`, throws `Error("shapes[2].rect[1]: unknown name 'xx'")`-style messages;
  - `face.frame(f, minH) → Frame`: evaluates `vars`, `when`, every shape's numbers and the anchors once;
  - `frame.lit(x, y) → null | { color, level }` and `frame.on(x, y) → boolean` (monochrome, with dithering);
  - `frame.items`: the evaluated shapes, for the vector display; `frame.anchors`.
- `web/js/faceview.js`: the glue to the displays: `formatLit(face)` gives the `(f, x, y, minH)` function that
  `oled()`, `dots()` and `matrice()` already take (frame cached per state object), `formatAnchors(face)`, and
  `drawFace(face)` for `vector()`.
- `web/faces/*.eliface` (the faces shipped with Eli) and `web/faces/index.json`, the single map of theme id →
  `{ face, display }` read by the page and the server.
- `THEMES` keeps its ids so saved settings stay valid.

## 3. The ESP32, live (second plan, once the web side passes)

- `firmware/esp32/src/faceformat.{h,cpp}`: the same compile and evaluation in C++17 (float), formulas compiled to the
  same stack programs, the face kept in PSRAM.
- New route `POST /face` (`{"grid": 128 | 42 | 32, "face": {...}}`, at most 16 KB): compile; on success, swap the
  active face; on error, reply 400 with the reason and keep the previous face. `GET /state` and the `/clip` reply
  report the active face id (`""` when none).
- The server pushes the face when the user picks a theme, and again whenever a `/clip` reply shows a different face
  id (the board rebooted).
- The three hand-ported themes (`pixel`, `blocs`, `perles`) stay as the fallback when no face was pushed.

## 4. Comparison and tests

- **Backup and switch**: the code faces stay. `?faces=format` in the page URL makes every theme use its face file;
  without it, nothing changes.
- `web/tests/faceexpr.test.mjs`, `web/tests/faceformat.test.mjs`: the language, each primitive and modifier, the
  painter's rule, mirror order, limits and error messages.
- `web/tests/faceparity.test.mjs`: `pixel.eliface` vs `pixLit`, `chat-pixel.eliface` vs `catLit` on grids of 128, 42
  and 32 columns, `matrice.eliface` vs `matLit` on the 19×19 grid, over a seeded sweep of states (gaze, open, hap, sc,
  bo, ang both signs, mouth w/o/r/t, T across the ear twitch): **0 differing cells**.
- `firmware/esp32/test/`: the C++ evaluator renders the sweep from the same files; `check.mjs` compares it to the JS
  evaluator with the tolerance the current port already has (at most 4 pixels per frame: float on the board, double
  in JS).
- Vector faces (`trait`, `trait-doux`, `trait-contour` with `trait-neon`, `chaton`): rebuilt and compared by eye,
  side by side. The Bezier lips of `trait` become half ellipses; small differences there are expected and accepted.
- `oscillo` stays code.

## Risks

- **Same math, same rounding**: the parity faces use `region` wherever a primitive would round differently from the
  code it replaces (`(y - ey) - 0.04` is not `y - (ey + 0.04)` in floating point). A sweep that flips cells points at
  a formula written differently, which is fixed in the face file, never by a tolerance.
- **Per-pixel cost on the ESP32**: 8192 cells × up to 64 shapes, plus `region` programs per pixel. Measured on the
  board in the firmware task; if a frame takes more than 20 ms, shapes get a per-frame bounding box.
- **Expressiveness gaps** found while porting the vector faces: extend the primitive list only when a face needs it,
  and record each addition in this spec.
