"""The morning brief: at the day's first wake-up, Eli says hello, the date, the weather, and a word about you.

The weather comes from Open-Meteo (free, no key) for the city BRIEF_CITY; without a city, it goes without.
"""
from __future__ import annotations

import datetime as dt
import json
import logging
import urllib.parse
import urllib.request
from functools import lru_cache

log = logging.getLogger("eli.brief")

DAYS = {"fr": ("lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"),
        "en": ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")}
MONTHS = {"fr": ("janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre",
                 "novembre", "décembre"),
          "en": ("January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
                 "November", "December")}
# WMO weather codes (Open-Meteo), grouped: (highest code included, label).
SKY = {"fr": ((0, "ciel dégagé"), (2, "quelques nuages"), (3, "ciel couvert"), (48, "brouillard"), (57, "bruine"),
              (67, "pluie"), (77, "neige"), (82, "averses"), (86, "averses de neige"), (99, "orages")),
       "en": ((0, "clear sky"), (2, "a few clouds"), (3, "overcast"), (48, "fog"), (57, "drizzle"),
              (67, "rain"), (77, "snow"), (82, "showers"), (86, "snow showers"), (99, "thunderstorms"))}
UNSURE = {"fr": "temps incertain", "en": "uncertain weather"}


def _get(url: str, **params) -> dict:
    with urllib.request.urlopen(f"{url}?{urllib.parse.urlencode(params)}", timeout=6) as r:
        return json.loads(r.read())


@lru_cache(maxsize=4)
def _place(city: str, lang: str = "fr") -> tuple[float, float, str]:
    hit = _get("https://geocoding-api.open-meteo.com/v1/search", name=city, count=1, language=lang)["results"][0]
    return hit["latitude"], hit["longitude"], hit.get("timezone", "auto")


def sky(code: int, lang: str = "fr") -> str:
    return next(label for top, label in SKY[lang] if code <= top) if 0 <= code <= 99 else UNSURE[lang]


def weather(city: str, lang: str = "fr") -> str | None:
    """E.g. "rain, 9 to 14 °C, 80% chance of rain"; None if the city or the network is missing."""
    if not city:
        return None
    try:
        lat, lon, tz = _place(city, lang)
        d = _get("https://api.open-meteo.com/v1/forecast", latitude=lat, longitude=lon, timezone=tz, forecast_days=1,
                 daily="weather_code,temperature_2m_min,temperature_2m_max,precipitation_probability_max")["daily"]
    except (OSError, ValueError, KeyError, IndexError) as exc:
        log.warning("no weather for %s: %s", city, exc)
        return None
    rain, low, high = d["precipitation_probability_max"][0], round(d["temperature_2m_min"][0]), round(d["temperature_2m_max"][0])
    if lang == "en":
        return f"{sky(d['weather_code'][0], lang)}, {low} to {high} °C" + (f", {rain}% chance of rain" if rain is not None else "")
    return f"{sky(d['weather_code'][0])}, {low} à {high} °C" + (f", {rain} % de risque de pluie" if rain is not None else "")


def prompt(now: dt.datetime, city: str, lang: str = "fr") -> str:
    """The message (in parentheses, like the introductions) that starts the morning brief."""
    today = weather(city, lang)
    if lang == "en":
        date = f"{DAYS['en'][now.weekday()]}, {MONTHS['en'][now.month - 1]} {now.day}"
        meteo = (f" Weather in {city}: {today}. Say it, and what to bring (jacket, umbrella…)." if today
                 else " You don't know the weather: don't mention it, don't make anything up.")
        return (f"(Morning brief. It's {date}, {now.hour}:{now.minute:02d}.{meteo} I just arrived: say good morning "
                "and give me the brief in three short sentences at most: the day, then a word tied to what you know "
                "about me. No question.)")
    date = f"{DAYS['fr'][now.weekday()]} {now.day} {MONTHS['fr'][now.month - 1]}"
    meteo = (f" Météo à {city} : {today}. Dis-la et ce qu'il faut prévoir (veste, parapluie…)." if today
             else " Tu ne connais pas la météo : n'en parle pas, n'invente rien.")
    return (f"(Point du matin. Nous sommes {date}, il est {now.hour} h {now.minute:02d}.{meteo} Je viens d'arriver : "
            "dis-moi bonjour et fais le point en trois phrases courtes au plus : le jour, puis un mot lié à ce que tu "
            "sais de moi. Pas de question.)")


if __name__ == "__main__":
    assert sky(0) == "ciel dégagé" and sky(63) == "pluie" and sky(95) == "orages" and sky(-1) == "temps incertain"
    assert sky(63, "en") == "rain" and sky(-1, "en") == "uncertain weather"
    assert all(len(SKY["en"]) == len(SKY["fr"]) and len(DAYS[k]) == 7 and len(MONTHS[k]) == 12 for k in SKY)
    p = prompt(dt.datetime(2026, 10, 1, 8, 5), "")
    assert "jeudi 1 octobre" in p and "8 h 05" in p and "n'invente rien" in p
    p = prompt(dt.datetime(2026, 10, 1, 8, 5), "", "en")
    assert "Thursday, October 1" in p and "8:05" in p and "make anything up" in p
    print("ok")
