// Two hobby servos (pan/tilt) that turn the head toward where the eyes look. Calibration lives in config.h.
#include <Arduino.h>

#include <algorithm>
#include <cmath>

#include "config.h"
#include "eli.h"

namespace {
constexpr uint32_t SERVO_HZ = 50, SERVO_BITS = 14;  // 20 ms period, 16384 steps ≈ 0.1°

struct Axis {
  const ServoCal& cal;
  uint8_t channel;  // LEDC channel (core 2.x); core 3.x addresses the pin directly
  float angle, sent;
};
Axis pan{NECK_PAN, 0, 0, -1}, tilt{NECK_TILT, 1, 0, -1};

float home(const ServoCal& c) { return std::min(c.maxDeg, std::max(c.minDeg, c.centerDeg + c.trimDeg)); }

void write(Axis& a) {
  const float us = a.cal.usAt0 + (a.cal.usAt180 - a.cal.usAt0) * a.angle / 180.0f;
  const uint32_t duty = lroundf(us * ((1 << SERVO_BITS) - 1) / (1e6f / SERVO_HZ));
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(a.cal.pin, duty);
#else
  ledcWrite(a.channel, duty);
#endif
  a.sent = a.angle;
}

void attach(Axis& a) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcAttach(a.cal.pin, SERVO_HZ, SERVO_BITS);
#else
  ledcSetup(a.channel, SERVO_HZ, SERVO_BITS);
  ledcAttachPin(a.cal.pin, a.channel);
#endif
  a.angle = home(a.cal);
  write(a);
}

// gaze: -1..1 (eye space). Ease toward the target, cap the speed, stay inside the mechanical limits.
void follow(Axis& a, float gaze, float dt) {
  const ServoCal& c = a.cal;
  const float target = std::min(c.maxDeg, std::max(c.minDeg, home(c) + c.rangeDeg * std::max(-1.0f, std::min(1.0f, gaze * NECK_FOLLOW))));
  const float step = (target - a.angle) * (1 - expf(-NECK_EASE * dt)), cap = NECK_MAX_DEG_S * dt;
  a.angle += std::max(-cap, std::min(cap, step));
  if (fabsf(a.angle - a.sent) >= NECK_DEADBAND_DEG) write(a);
}
}  // namespace

void neckBegin() {
  if (!NECK_ENABLED) return;
  attach(pan);
  attach(tilt);
}

void neckUpdate(float gx, float gy, float dt) {
  if (!NECK_ENABLED) return;
  follow(pan, gx, dt);
  follow(tilt, gy, dt);  // gaze y > 0 = looking down
}
