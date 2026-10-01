// Copy to secrets.h (gitignored) and fill in.
#pragma once

#define WIFI_SSID "your-wifi"
#define WIFI_PASSWORD "your-password"

// Eli's Python server, for push-to-talk (POST /brain/listen). Use its LAN IP: the server only answers host names
// listed in its ALLOWED_HOSTS. It must listen on the network too: HOST=0.0.0.0 in the server's .env.
#define SERVER_URL "http://192.168.1.20:5280"
