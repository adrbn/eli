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

JSON, extension `.eliface`, at most 16 KB and 64 shapes after mirroring.

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
  "anchors": { "eyeL": ["1 - 0.4 + gx*0.125", "ey"], "eyeR": ["1 + 0.4 + gx*0.125", "ey"], "crown": ["1", "0.1"] }
}
```

### Space

- `"wide"` (default): the current 2:1 frame, x in [0, 2], y in [0, 1], y down.
- `"square"`: x and y in [-1, 1], for faces designed for the round matrix.

A display maps its cells into the face's space; a wide face on the matrix uses the mapping the masks use today
(`xf` in `matrice()`).

### Variables available to formulas

| Name | Meaning |
| --- | --- |
| `gx gy open hap sc bo ang` | eyes: gaze, openness, smile, scale, bounce, eyelid angle (`f.eyes`) |
| `w o r t` | mouth: width, opening, roundness, teeth (`f.mouth`) |
| `T` | seconds since start (`f.T`) |
| `minH` | the display's minimum visible height (0.55 / rows) |
| `rows` | `round(0.55 / minH)`, for grid-aware patterns |
| `s` | -1 or +1 inside a `mirror` group, 1 elsewhere |
| any name in `vars` | evaluated in order, once per frame (and once per side for names that use `s`) |

### Formulas

A string (or a plain number). Grammar: numbers, names, `+ - * /`, unary `-`, `< <= > >= == !=`, `&& || !`,
`a ? b : c`, parentheses, functions `min max clamp abs floor mod sin cos hypot sqrt`. No loops, no assignment, no
access to anything outside the variables: a face cannot run code. Unknown names, unknown functions and syntax errors
are rejected when the file is compiled, with the field's path in the message.

### Shapes

Each shape is one primitive, plus optional modifiers.

| Primitive | Arguments | Inside when |
| --- | --- | --- |
| `rect` | `[cx, cy, halfW, halfH]`, `radius` | rounded-box SDF <= 0 (same `sdBox` as today) |
| `ellipse` | `[cx, cy, rx, ry]` | `((x-cx)/rx)^2 + ((y-cy)/ry)^2 <= 1` |
| `segment` | `[ax, ay, bx, by]`, `stroke` | distance to the segment < stroke |
| `triangle` | `[ax, ay, bx, by, cx, cy]` | same `inTri` as today |
| `halfplane` | `[ax, ay, bx, by]` | left of the line a→b (y down) |

Modifiers:

- `stroke`: on `ellipse`, a ring of absolute thickness: `abs(d - 1) * min(rx, ry) < stroke`, where
  `d = hypot((x-cx)/rx, (y-cy)/ry)` (the cat's head); on `segment`, the half thickness.
- `ring`: on `ellipse`, a ring in normalized units: `abs(d - 1) < ring` (the happy eyes of the cat and the matrix).
- `k`: on `ellipse`, the radius threshold: inside when `d <= k` (default: the sum-of-squares test `<= 1`, as
  `pixLit` writes it). `catLit`'s `head > 1.05` is `{ "outside": { "ellipse": [...], "k": 1.05 } }`.
- `cut`: paints "off" instead of "on".
- `when`: a formula; the shape is skipped when it is 0.
- `clip`: `{ "inside": <shape> }` or `{ "outside": <shape> }`; the shape only counts where the clip holds.
- `dots`: checkerboard fill, `(floor(x/2*rows*2) + floor(y*rows)) % 2 == 0` (the cat's cheeks and ears).
- `color`: any CSS hex color; absent means the ink chosen in the app. The OLED converts color to on/off by
  luminance (> 0.2 lights).
- `level`: intensity 0..1, for the matrix and LED displays (default 1).
- `mirror: true` with `group`: the group is evaluated twice, with `s = -1` and `s = 1`.

### Order

Painter's rule: shapes are tested from the **last** to the first; the first one whose test holds decides the pixel
(on with its color, or off for `cut`). This reproduces the early `return`s of `pixLit`, `catLit` and `matLit` by
listing their tests in reverse.

### Anchors

Named points (formulas) where outfits and accessories sit, so a look fits any face. `looks.js` reads
`eyeL eyeR crown` (and the existing `pixAnchors`/`catAnchors` fields mapped onto them). Missing anchors fall back to
`pixAnchors`.

## 2. Evaluator and displays (web)

- `web/js/faceformat.js`, pure, no DOM:
  - `compile(json) → Face | throws Error(path: reason)`: validates the structure and limits, parses every formula
    into a small stack program.
  - `face.frame(state, minH) → Frame`: evaluates `vars` and every shape's numbers once.
  - `frame.lit(x, y) → null | { color, level }`: walks the shapes per the painter's rule.
  - `frame.shapes()`: the evaluated primitives, for the vector display.
- Displays are unchanged: `oled()`, `dots()` and `matrice()` already take a `lit` function; a format face passes
  `(f, x, y, minH) => frame.lit(x, y)` (the frame cached per `f`). `vector()` gets a `drawShapes(ctx, frame)` that
  fills/strokes the same primitives on the canvas.
- The theme list becomes face × display: a face file brings its default `display`; the user may pick another.
  `THEMES` keeps its ids so saved settings stay valid.
- Faces shipped with Eli live in `web/faces/*.eliface`.

## 3. The ESP32, live

- `firmware/esp32/src/faceformat.{h,cpp}`: the same compile and evaluation in C++17 (float), formulas compiled to the
  same stack programs, shapes kept in PSRAM.
- New route `POST /face` (JSON body, at most 16 KB): compile; on success, swap the active face; on error, reply
  400 with the reason and keep the previous face. `GET /state` reports the face id.
- The server pushes the chosen face's file when the user selects it and when the board connects.
- The three hand-ported themes (`pixel`, `blocs`, `perles`) stay as the fallback when no face was pushed.

## 4. Comparison and tests

- **Backup and switch**: the code faces stay. A hidden dev setting (`?faces=code|format`, default `code` until the
  acceptance passes) picks which implementation each theme uses, for side-by-side checks.
- `web/tests/faceformat.test.mjs`:
  - formula parser: precedence, functions, errors with paths, rejection of unknown names;
  - shapes: one test per primitive and modifier;
  - **pixel parity**: `pixel.eliface` vs `pixLit`, `chat-pixel.eliface` vs `catLit`, `matrice.eliface` vs `matLit`,
    on grids of 128, 42, 32 and 19 columns, over a seeded sweep of states (gaze, open, hap, sc, bo, ang both signs,
    mouth w/o/r/t, T for the ear twitch): **0 differing cells**.
- `firmware/esp32/test/`: the C++ evaluator renders the same sweep from the same `.eliface` files; `check.mjs`
  compares it to JS, as `check.cpp` does today for `pixel.cpp`. Float vs double: the test reports any differing cell;
  the target is 0, and any difference is investigated, not tolerated.
- Vector faces (`trait`, `trait-doux`, `trait-contour`, `trait-neon`, `chaton`): rebuilt and compared by eye, side by
  side. The Bezier lips of `trait` become arcs/ellipses; small differences there are expected and accepted.
- `oscillo` stays code.

## Risks

- **Exactness vs float**: the C++ side uses float; boundary cells may flip. Mitigation: evaluate formulas in double
  on the C++ side too if a sweep shows differences (cost is per frame, not per pixel).
- **Per-pixel cost on the ESP32**: 8192 cells × up to 64 shapes per frame. Mitigation: shapes carry a bounding box
  computed per frame; cells outside are skipped.
- **Same math, same rounding**: each primitive's test is written exactly as the code it replaces (sum of squares vs
  `hypot`, normalized vs absolute rings). A sweep that flips cells points at a formula written differently, which is
  fixed in the face file, never by a tolerance.
- **Expressiveness gaps** found while porting the vector faces: extend the primitive list only when a face needs it,
  and record each addition in this spec.
