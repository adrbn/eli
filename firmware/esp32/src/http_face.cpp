// The face side of Eli's protocol (server/app.py, README "Protocol"): POST /clip, /stop, /state, /gaze, /theme.
// A deliberately tiny HTTP/1.1 server, one request per connection: the brain is the only regular client, and
// owning the parser keeps big headers (X-Phonemes, up to ~7 kB) and multi-MB bodies (straight into PSRAM) in hand.
// Same guards as the Python server: Host must be an IP or our mDNS name (DNS rebinding), a foreign Origin is
// refused, and form-like content types are refused (they're what another web page could send without asking).
#include <Arduino.h>
#include <ArduinoJson.h>
#include <WiFi.h>

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstring>
#include <string>

#include "config.h"
#include "eli.h"
#include "pixel.h"

namespace {
WiFiServer server(HTTP_PORT);

struct Req {
  std::string method, path, query, ctype, host, origin, phonemes, mood;
  long length = -1;
};

std::string lower(std::string s) {
  for (char& c : s) c = tolower(static_cast<unsigned char>(c));
  return s;
}

bool readLine(WiFiClient& c, std::string& out, size_t max, uint32_t start) {
  out.clear();
  while (millis() - start < BODY_IDLE_TIMEOUT_MS) {
    const int ch = c.read();
    if (ch < 0) {
      if (!c.connected()) return false;
      delay(1);
      continue;
    }
    if (ch == '\n') {
      if (!out.empty() && out.back() == '\r') out.pop_back();
      return true;
    }
    if (out.size() >= max) return false;
    out += static_cast<char>(ch);
  }
  return false;
}

bool readHead(WiFiClient& c, Req& r) {
  const uint32_t start = millis();
  std::string line;
  if (!readLine(c, line, 2048, start)) return false;
  const size_t a = line.find(' '), b = line.find(' ', a + 1);
  if (a == std::string::npos || b == std::string::npos) return false;
  r.method = line.substr(0, a);
  const std::string target = line.substr(a + 1, b - a - 1);
  const size_t q = target.find('?');
  r.path = target.substr(0, q);
  r.query = q == std::string::npos ? "" : target.substr(q + 1);
  for (size_t total = 0;;) {
    if (!readLine(c, line, MAX_HEADER_LINE, start)) return false;
    if (line.empty()) return true;
    if ((total += line.size()) > MAX_HEADERS) return false;
    const size_t colon = line.find(':');
    if (colon == std::string::npos) continue;
    const std::string name = lower(line.substr(0, colon));
    std::string value = line.substr(colon + 1);
    value.erase(0, value.find_first_not_of(" \t"));
    if (name == "content-length") r.length = value.empty() || !isdigit(static_cast<unsigned char>(value[0])) ? -1 : atol(value.c_str());
    else if (name == "content-type") r.ctype = lower(value.substr(0, value.find(';')));
    else if (name == "host") r.host = lower(value);
    else if (name == "origin") r.origin = lower(value);
    else if (name == "x-phonemes") r.phonemes = value;
    else if (name == "x-mood") r.mood = value;
  }
}

std::string param(const std::string& query, const char* key) {
  const std::string k = std::string(key) + "=";
  for (size_t at = 0; at < query.size();) {
    const size_t end = std::min(query.find('&', at), query.size());
    if (!query.compare(at, k.size(), k)) return eli::urlDecode(query.substr(at + k.size(), end - at - k.size()));
    at = end + 1;
  }
  return "";
}

bool hostOk(const std::string& host) {
  if (host.empty()) return false;
  if (host[0] == '[') return true;  // IPv6 literal
  const std::string name = host.substr(0, host.find(':'));
  if (name == MDNS_NAME ".local" || name == MDNS_NAME) return true;
  return !name.empty() && name.find_first_not_of("0123456789.") == std::string::npos;
}

bool originOk(const Req& r) {
  if (r.origin.empty()) return true;
  const size_t at = r.origin.find("://");
  return at != std::string::npos && r.origin.substr(at + 3) == r.host;
}

const char* reason(int code) {
  switch (code) {
    case 200: return "OK";
    case 400: return "Bad Request";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    case 405: return "Method Not Allowed";
    case 411: return "Length Required";
    case 413: return "Payload Too Large";
    case 415: return "Unsupported Media Type";
    case 503: return "Service Unavailable";
    default: return "Error";
  }
}

void reply(WiFiClient& c, int code, const JsonDocument& doc) {
  std::string body;
  serializeJson(doc, body);
  char head[160];
  const int n = snprintf(head, sizeof head,
                         "HTTP/1.1 %d %s\r\nContent-Type: application/json\r\nContent-Length: %u\r\nConnection: close\r\n\r\n",
                         code, reason(code), static_cast<unsigned>(body.size()));
  c.write(reinterpret_cast<const uint8_t*>(head), n);
  c.write(reinterpret_cast<const uint8_t*>(body.data()), body.size());
}

void ok(WiFiClient& c) {
  JsonDocument doc;
  doc["ok"] = true;
  reply(c, 200, doc);
}

void fail(WiFiClient& c, int code, const char* error) {
  JsonDocument doc;
  doc["ok"] = false;
  doc["error"] = error;
  reply(c, code, doc);
}

bool readBody(WiFiClient& c, uint8_t* buf, size_t len) {
  size_t got = 0;
  uint32_t last = millis();
  while (got < len) {
    const int r = c.read(buf + got, len - got);
    if (r > 0) {
      got += r;
      last = millis();
    } else if (!c.connected() || millis() - last > BODY_IDLE_TIMEOUT_MS) {
      return false;
    } else {
      delay(1);
    }
  }
  return true;
}

bool simpleType(const std::string& t) {  // what a cross-site form or fetch may send without a preflight
  return t == "text/plain" || t == "application/x-www-form-urlencoded" || t == "multipart/form-data";
}

// X-Phonemes: URL-encoded JSON [[phoneme, ms], …]. Anything off → no phonemes (the mouth follows the sound).
bool phonemes(const std::string& header, std::vector<eli::Phone>& out) {
  if (header.empty()) return false;
  JsonDocument doc;
  if (deserializeJson(doc, eli::urlDecode(header)) || !doc.is<JsonArrayConst>()) return false;
  JsonArrayConst arr = doc.as<JsonArrayConst>();
  if (arr.size() >= 2000) return false;
  out.reserve(arr.size());
  for (JsonVariantConst v : arr) {
    JsonArrayConst pair = v.as<JsonArrayConst>();
    if (pair.size() != 2 || !pair[0].is<const char*>() || !pair[1].is<int>()) return false;
    const int ms = pair[1].as<int>();
    eli::Phone p;
    if (ms < 0 || ms >= 10000 || !eli::decodePhone(pair[0].as<const char*>(), ms, p)) return false;
    out.push_back(p);
  }
  return true;
}

void postClip(WiFiClient& c, const Req& r) {
  const std::string kind = param(r.query, "kind").empty() ? "speech" : param(r.query, "kind");
  if (kind != "speech" && kind != "music") return fail(c, 400, "kind must be speech or music");
  if (simpleType(r.ctype)) return fail(c, 415, "send the raw audio file (audio/wav)");
  if (r.ctype.rfind("audio/", 0) == 0 && r.ctype != "audio/wav" && r.ctype != "audio/x-wav" && r.ctype != "audio/wave" &&
      r.ctype != "audio/vnd.wave")
    return fail(c, 415, "this face plays WAV only (16-bit PCM mono)");
  if (r.length <= 0) return fail(c, 411, "Content-Length required");
  if (r.length > static_cast<long>(MAX_CLIP_BYTES)) return fail(c, 413, "clip too big");
  bool full;
  {
    std::lock_guard<std::mutex> lock(g.mu);
    full = g.queuedBytes + r.length > QUEUE_BYTES;
  }
  if (full) return fail(c, 503, "queue full");
  const std::string t = param(r.query, "turn");
  const int turn = t.empty() || t.size() > 9 || t.find_first_not_of("0123456789") != std::string::npos ? 0 : atoi(t.c_str());

  auto* clip = new eli::Clip;
  clip->bytes = r.length;
  clip->data = static_cast<uint8_t*>(eli::bigAlloc(r.length));
  if (!clip->data) {
    delete clip;
    return fail(c, 503, "out of memory");
  }
  if (!readBody(c, clip->data, clip->bytes)) {
    delete clip;
    return fail(c, 400, "body shorter than Content-Length");
  }
  if (const char* err = eli::parseWav(*clip)) {
    delete clip;
    return fail(c, 415, err);
  }
  clip->music = kind == "music";
  clip->turn = turn;
  clip->mood = eli::moodIndex(eli::urlDecode(r.mood));
  std::vector<eli::Phone> ph;
  const bool hasPh = !clip->music && phonemes(r.phonemes, ph);
  if (!eli::buildTrack(*clip, hasPh ? &ph : nullptr)) {
    delete clip;
    return fail(c, 503, "out of memory");
  }
  const float seconds = static_cast<float>(clip->samples) / clip->rate;
  bool dropped;
  uint32_t id = 0;
  {
    std::lock_guard<std::mutex> lock(g.mu);
    dropped = turn > 0 && turn < g.minTurn;  // what's left of an interrupted answer
    if (!dropped) {
      clip->id = id = ++g.clipSeq;
      g.lastTurn = std::max(g.lastTurn, turn);
      g.queuedBytes += clip->bytes;
      g.queue.push_back(clip);
      g.wake = true;
    }
  }
  if (dropped) delete clip;
  JsonDocument doc;
  doc["ok"] = true;
  doc["kind"] = kind;
  doc["turn"] = turn;
  if (dropped) {
    doc["dropped"] = true;
  } else {
    doc["id"] = id;
    doc["seconds"] = roundf(seconds * 100) / 100;
    doc["phonemes"] = hasPh;
  }
  reply(c, 200, doc);
}

const char* apply(const std::string& path, JsonDocument& in);

void postJson(WiFiClient& c, const Req& r) {
  JsonDocument in;
  if (r.length > 0) {  // only /stop may come empty
    if (r.ctype != "application/json") return fail(c, 415, "JSON expected");
    if (r.length > static_cast<long>(MAX_JSON)) return fail(c, 413, "body too big");
    std::string body(r.length, '\0');
    if (!readBody(c, reinterpret_cast<uint8_t*>(&body[0]), body.size())) return fail(c, 400, "body shorter than Content-Length");
    if (deserializeJson(in, body) || !in.is<JsonObject>()) return fail(c, 400, "JSON object expected");
  } else if (r.path != "/stop") {
    return fail(c, 400, "JSON body expected");
  }

  const char* err = apply(r.path, in);
  if (err) return fail(c, 400, err);
  ok(c);
}

// The JSON routes' effect on the shared state; nullptr, or what's wrong with the request.
const char* apply(const std::string& path, JsonDocument& in) {
  std::lock_guard<std::mutex> lock(g.mu);
  if (path == "/stop") {  // {} or {"turn": N} (+ {"keep": "music"})
    if (!in["turn"].isNull() && !in["turn"].is<int>()) return "expected {} or {\"turn\": N}";
    if (in["turn"].is<int>()) {
      const int turn = in["turn"];
      g.minTurn = std::max(g.minTurn, turn);
      g.lastTurn = std::max(g.lastTurn, turn);
    } else {  // a human said stop: whatever is still on its way from this turn is stale too
      g.minTurn = std::max(g.minTurn, g.lastTurn + 1);
    }
    stopPlayback(in["keep"] == "music");
  } else if (path == "/state") {
    const std::string mode = in["mode"] | "";
    if (mode == "idle") g.mode = eli::Mode::Idle;
    else if (mode == "listen") g.mode = eli::Mode::Listen;
    else if (mode == "think") g.mode = eli::Mode::Think;
    else return "mode must be idle, listen or think";
  } else if (path == "/gaze") {  // {"x": -1..1, "y": -1..1}, or {} to free the gaze
    if (in.size() == 0) {
      g.hasGaze = false;
    } else {
      if (!in["x"].is<float>() || !in["y"].is<float>()) return "expected {\"x\": -1..1, \"y\": -1..1} or {}";
      const float x = in["x"], y = in["y"];
      if (!std::isfinite(x) || !std::isfinite(y)) return "x and y must be numbers";
      g.gazeX = std::max(-1.0f, std::min(1.0f, x));
      g.gazeY = std::max(-1.0f, std::min(1.0f, y));
      g.hasGaze = true;
    }
  } else if (path == "/theme") {
    const char* id = in["id"] | "";
    const size_t len = strlen(id);
    if (!len || len > 32 || strspn(id, "abcdefghijklmnopqrstuvwxyz0123456789-") != len) return "invalid theme id";
    const int theme = eli::themeIndex(id);
    if (theme < 0) return "this face draws: pixel, blocs, perles";
    g.theme = theme;
  }
  return nullptr;
}

void status(WiFiClient& c) {
  static const char* const MODES[] = {"idle", "listen", "think"};
  JsonDocument doc;
  {
    std::lock_guard<std::mutex> lock(g.mu);
    doc["ok"] = true;
    doc["name"] = MDNS_NAME;
    doc["theme"] = eli::THEMES[g.theme];
    doc["mode"] = MODES[std::min(2, static_cast<int>(g.mode))];
    doc["queued"] = g.queue.size();
    doc["playing"] = g.playing != nullptr;
    doc["minTurn"] = g.minTurn;
  }
  doc["heap"] = ESP.getFreeHeap();
  doc["psram"] = ESP.getFreePsram();
  reply(c, 200, doc);
}

void handle(WiFiClient& c) {
  Req r;
  if (!readHead(c, r)) return fail(c, 400, "bad request");
  if (!hostOk(r.host) || !originOk(r)) return fail(c, 403, "host or origin refused");
  if (r.method == "GET" && (r.path == "/" || r.path == "/status")) return status(c);
  const bool json = r.path == "/stop" || r.path == "/state" || r.path == "/gaze" || r.path == "/theme";
  if (r.path != "/clip" && !json) return fail(c, 404, "unknown route (this face has no /events: it is not a web page)");
  if (r.method != "POST") return fail(c, 405, "POST expected");
  if (r.path == "/clip") return postClip(c, r);
  postJson(c, r);
}

void httpTask(void*) {
  while (WiFi.status() != WL_CONNECTED) vTaskDelay(pdMS_TO_TICKS(200));
  server.begin();
  for (;;) {
    WiFiClient c = server.available();
    if (!c) {
      vTaskDelay(pdMS_TO_TICKS(5));
      continue;
    }
    handle(c);
    c.stop();
  }
}
}  // namespace

void httpBegin() { xTaskCreatePinnedToCore(httpTask, "http", 8192, nullptr, 2, nullptr, 0); }
