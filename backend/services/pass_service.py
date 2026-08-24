"""
services/pass_service.py — Расчёт пролётов спутников над точкой наблюдателя.

Использует Skyfield для вычисления моментов восхода/захода спутника
над горизонтом наблюдателя и максимальной элевации.
"""

import math
from datetime import datetime, timedelta, timezone
from typing import List, Dict, Any, Optional

from skyfield.api import EarthSatellite, wgs84
from backend.services.tle_parser import ts


def find_passes(
    satellite: EarthSatellite,
    observer_lat: float,
    observer_lon: float,
    hours: int = 24,
    min_elevation: float = 5.0,
    observer_alt: float = 0.0,
) -> List[Dict[str, Any]]:
    """
    Рассчитать пролёты спутника над точкой наблюдения.

    Args:
        satellite: Объект EarthSatellite (skyfield).
        observer_lat: Широта наблюдателя (градусы).
        observer_lon: Долгота наблюдателя (градусы).
        hours: Окно поиска (часы вперёд от текущего момента).
        min_elevation: Минимальная элевация для учёта пролёта (градусы).
        observer_alt: Высота наблюдателя над уровнем моря (м).

    Returns:
        Список пролётов, каждый содержит:
        {
            "rise_time": ISO str,
            "rise_azimuth": float (degrees),
            "max_time": ISO str,
            "max_elevation": float (degrees),
            "set_time": ISO str,
            "set_azimuth": float (degrees),
            "duration_seconds": int,
        }
    """
    now = datetime.now(timezone.utc)
    t0 = ts.from_datetime(now)
    t1 = ts.from_datetime(now + timedelta(hours=hours))

    observer = wgs84.latlon(observer_lat, observer_lon, observer_alt)
    difference = satellite - observer

    passes = []

    try:
        # Skyfield find_events: 0=rise, 1=culmination, 2=set
        t_events, events = satellite.find_events(observer, t0, t1, altitude_degrees=min_elevation)
    except Exception:
        return passes

    # Group events into passes (rise → culmination → set)
    i = 0
    while i < len(events):
        # Find a rise event
        if events[i] != 0:
            i += 1
            continue

        rise_t = t_events[i]
        max_t = None
        set_t = None
        max_elev = min_elevation

        # Look for culmination and set
        j = i + 1
        while j < len(events) and events[j] != 0:
            if events[j] == 1:
                max_t = t_events[j]
                # Calculate elevation at culmination
                try:
                    alt_deg, az_deg, dist = difference.at(max_t).altaz()
                    max_elev = alt_deg.degrees
                except Exception:
                    pass
            elif events[j] == 2:
                set_t = t_events[j]
                j += 1
                break
            j += 1

        if max_t and set_t:
            rise_dt = rise_t.utc_datetime()
            max_dt = max_t.utc_datetime()
            set_dt = set_t.utc_datetime()
            duration = int((set_dt - rise_dt).total_seconds())

            # Calculate azimuths at rise and set
            rise_az = 0.0
            set_az = 0.0
            try:
                _, az_r, _ = difference.at(rise_t).altaz()
                rise_az = az_r.degrees
                _, az_s, _ = difference.at(set_t).altaz()
                set_az = az_s.degrees
            except Exception:
                pass

            passes.append({
                "rise_time": rise_dt.isoformat(),
                "rise_azimuth": round(rise_az, 1),
                "max_time": max_dt.isoformat(),
                "max_elevation": round(max_elev, 1),
                "set_time": set_dt.isoformat(),
                "set_azimuth": round(set_az, 1),
                "duration_seconds": duration,
            })

        i = j

    return passes
