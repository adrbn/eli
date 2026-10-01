"""Le point du matin : au premier réveil de la journée, Eli dit bonjour, la date, la météo, et un mot qui te concerne.

La météo vient d'Open-Meteo (gratuit, sans clé) pour la ville BRIEF_CITY ; sans ville, il s'en passe.
"""
from __future__ import annotations

import datetime as dt
import json
import logging
import urllib.parse
import urllib.request
from functools import lru_cache

log = logging.getLogger("eli.brief")

DAYS = ("lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche")
MONTHS = ("janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre",
          "novembre", "décembre")
# Codes météo WMO (Open-Meteo), regroupés : (code max inclus, libellé).
SKY = ((0, "ciel dégagé"), (2, "quelques nuages"), (3, "ciel couvert"), (48, "brouillard"), (57, "bruine"),
       (67, "pluie"), (77, "neige"), (82, "averses"), (86, "averses de neige"), (99, "orages"))


def _get(url: str, **params) -> dict:
    with urllib.request.urlopen(f"{url}?{urllib.parse.urlencode(params)}", timeout=6) as r:
        return json.loads(r.read())


@lru_cache(maxsize=4)
def _place(city: str) -> tuple[float, float, str]:
    hit = _get("https://geocoding-api.open-meteo.com/v1/search", name=city, count=1, language="fr")["results"][0]
    return hit["latitude"], hit["longitude"], hit.get("timezone", "auto")


def sky(code: int) -> str:
    return next(label for top, label in SKY if code <= top) if 0 <= code <= 99 else "temps incertain"


def weather(city: str) -> str | None:
    """« pluie, 9 à 14 °C, 80 % de risque de pluie », ou None si la ville ou le réseau manquent."""
    if not city:
        return None
    try:
        lat, lon, tz = _place(city)
        d = _get("https://api.open-meteo.com/v1/forecast", latitude=lat, longitude=lon, timezone=tz, forecast_days=1,
                 daily="weather_code,temperature_2m_min,temperature_2m_max,precipitation_probability_max")["daily"]
    except (OSError, ValueError, KeyError, IndexError) as exc:
        log.warning("météo indisponible pour %s : %s", city, exc)
        return None
    rain = d["precipitation_probability_max"][0]
    return (f"{sky(d['weather_code'][0])}, {round(d['temperature_2m_min'][0])} à {round(d['temperature_2m_max'][0])} °C"
            + (f", {rain} % de risque de pluie" if rain is not None else ""))


def prompt(now: dt.datetime, city: str) -> str:
    """Le message (entre parenthèses, comme les présentations) qui lance le point du matin."""
    date = f"{DAYS[now.weekday()]} {now.day} {MONTHS[now.month - 1]}"
    sky_today = weather(city)
    meteo = (f" Météo à {city} : {sky_today}. Dis-la et ce qu'il faut prévoir (veste, parapluie…)." if sky_today
             else " Tu ne connais pas la météo : n'en parle pas, n'invente rien.")
    return (f"(Point du matin. Nous sommes {date}, il est {now.hour} h {now.minute:02d}.{meteo} Je viens d'arriver : "
            "dis-moi bonjour et fais le point en trois phrases courtes au plus : le jour, puis un mot lié à ce que tu "
            "sais de moi. Pas de question.)")


if __name__ == "__main__":
    assert sky(0) == "ciel dégagé" and sky(63) == "pluie" and sky(95) == "orages" and sky(-1) == "temps incertain"
    p = prompt(dt.datetime(2026, 10, 1, 8, 5), "")
    assert "jeudi 1 octobre" in p and "8 h 05" in p and "n'invente rien" in p
    print("ok")
