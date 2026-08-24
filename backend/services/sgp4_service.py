"""
Orbital parameter helpers built on top of Skyfield/SGP4.
"""

import math
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from skyfield.api import EarthSatellite, wgs84

from backend.services.tle_parser import ts


LEO_MAX_ALT = 2000.0
MEO_MAX_ALT = 35786.0
GEO_ALT_MIN = 35586.0
GEO_ALT_MAX = 35986.0
HEO_ECCENTRICITY = 0.25
EARTH_RADIUS_KM = 6378.137
EARTH_MU = 398600.4418


def derive_orbit_altitudes(
    mean_motion: float,
    eccentricity: float,
) -> tuple[float, float, float] | None:
    """Estimate perigee/apogee/mean altitude from TLE mean motion."""
    if mean_motion <= 0:
        return None

    mean_motion_rad_s = mean_motion * 2.0 * math.pi / 86400.0
    semi_major_axis_km = (EARTH_MU / (mean_motion_rad_s ** 2)) ** (1.0 / 3.0)
    perigee_alt_km = semi_major_axis_km * (1.0 - eccentricity) - EARTH_RADIUS_KM
    apogee_alt_km = semi_major_axis_km * (1.0 + eccentricity) - EARTH_RADIUS_KM
    mean_alt_km = semi_major_axis_km - EARTH_RADIUS_KM
    return perigee_alt_km, apogee_alt_km, mean_alt_km


def classify_orbit(
    altitude_km: float,
    eccentricity: float,
    mean_motion: float | None = None,
) -> str:
    """
    Classify orbit using orbital elements first, falling back to current altitude.
    """
    if eccentricity > HEO_ECCENTRICITY:
        return "HEO"

    if mean_motion is not None:
        altitudes = derive_orbit_altitudes(mean_motion, eccentricity)
        if altitudes is not None:
            perigee_alt_km, apogee_alt_km, mean_alt_km = altitudes

            if (
                GEO_ALT_MIN <= mean_alt_km <= GEO_ALT_MAX
                and abs(apogee_alt_km - perigee_alt_km) <= 1000
            ):
                return "GEO"
            if apogee_alt_km < LEO_MAX_ALT:
                return "LEO"
            if perigee_alt_km >= LEO_MAX_ALT and apogee_alt_km <= MEO_MAX_ALT:
                return "MEO"
            if apogee_alt_km <= MEO_MAX_ALT:
                return "LEO"
            return "HEO"

    if altitude_km < LEO_MAX_ALT:
        return "LEO"
    if GEO_ALT_MIN <= altitude_km <= GEO_ALT_MAX:
        return "GEO"
    if altitude_km < GEO_ALT_MIN:
        return "MEO"
    return "HEO"


def get_position(
    satellite: EarthSatellite,
    dt: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Return current geodetic position plus key orbital parameters."""
    if dt is None:
        dt = datetime.now(timezone.utc)
    elif dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)

    t = ts.from_datetime(dt)
    geocentric = satellite.at(t)

    subpoint = wgs84.subpoint(geocentric)
    lat = subpoint.latitude.degrees
    lon = subpoint.longitude.degrees
    alt = subpoint.elevation.km

    velocity_vec = geocentric.velocity.km_per_s
    velocity = math.sqrt(sum(v ** 2 for v in velocity_vec))

    model = satellite.model
    inclination = math.degrees(model.inclo)
    eccentricity = model.ecco
    raan = math.degrees(model.nodeo)
    arg_perigee = math.degrees(model.argpo)
    mean_anomaly = math.degrees(model.mo)
    mean_motion = model.no_kozai * 1440.0 / (2.0 * math.pi)
    period = 1440.0 / mean_motion if mean_motion > 0 else 0.0
    epoch_dt = satellite.epoch.utc_datetime()
    orbit_type = classify_orbit(alt, eccentricity, mean_motion)
    norad_id = model.satnum

    return {
        "name": satellite.name,
        "norad_id": norad_id,
        "timestamp": dt.isoformat(),
        "lat": round(lat, 6),
        "lon": round(lon, 6),
        "altitude_km": round(alt, 3),
        "velocity_km_s": round(velocity, 4),
        "period_minutes": round(period, 2),
        "inclination_deg": round(inclination, 4),
        "eccentricity": round(eccentricity, 7),
        "raan_deg": round(raan, 4),
        "mean_motion": round(mean_motion, 8),
        "arg_perigee_deg": round(arg_perigee, 4),
        "mean_anomaly_deg": round(mean_anomaly, 4),
        "orbit_type": orbit_type,
        "epoch": epoch_dt.isoformat(),
    }


def get_track(
    satellite: EarthSatellite,
    start: Optional[datetime] = None,
    minutes: int = 90,
    steps: int = 180,
) -> List[Dict[str, Any]]:
    """Generate an orbital ground track for rendering."""
    if start is None:
        start = datetime.now(timezone.utc)
    elif start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)

    track: List[Dict[str, Any]] = []
    step_seconds = (minutes * 60) / steps

    for i in range(steps + 1):
        dt = start + timedelta(seconds=i * step_seconds)
        t = ts.from_datetime(dt)

        try:
            geocentric = satellite.at(t)
            subpoint = wgs84.subpoint(geocentric)
            track.append({
                "timestamp": dt.isoformat(),
                "lat": round(subpoint.latitude.degrees, 6),
                "lon": round(subpoint.longitude.degrees, 6),
                "altitude_km": round(subpoint.elevation.km, 3),
            })
        except Exception:
            continue

    return track
