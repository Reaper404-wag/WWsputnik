"""
services/tle_updater.py — Загрузка и обновление TLE-данных из Celestrak.

Раз в сутки загружает TLE для сконфигурированных групп,
парсит и сохраняет/обновляет записи в БД.
"""

import requests
import logging
from datetime import datetime, timezone
from typing import Dict, Any, List

from sqlalchemy.orm import Session

from backend.models.satellite import Satellite
from backend.services.tle_parser import parse_tle, extract_norad_id
from backend.services.sgp4_service import get_position, classify_orbit
from backend.config import get_settings
from backend.database import SessionLocal

logger = logging.getLogger(__name__)

settings = get_settings()

CELESTRAK_URL = "https://celestrak.org/NORAD/elements/gp.php"


# ========== Country / Operator detection from satellite name + intl designator ==========

# International Designator launch site → country mapping (first 2 digits = year, next chars = launch #)
# The classification letter after NORAD ID in line1 col 7 tells us the owner:
#   But more reliably, we detect by name patterns and intl designator patterns.

COUNTRY_BY_NAME = {
    # USA
    'STARLINK': 'USA', 'GPS': 'USA', 'TDRS': 'USA', 'GOES': 'USA', 'NOAA': 'USA',
    'CYGNUS': 'USA', 'DRAGON': 'USA', 'FALCON': 'USA', 'ATLAS': 'USA',
    'NROL': 'USA', 'USA ': 'USA', 'ORBCOMM': 'USA', 'IRIDIUM': 'USA',
    'GLOBALSTAR': 'USA', 'TERRA': 'USA', 'AQUA': 'USA', 'LANDSAT': 'USA',
    'WORLDVIEW': 'USA', 'GEOEYE': 'USA', 'SWARM': 'USA',
    'NAVSTAR': 'USA', 'SBIRS': 'USA', 'WGS': 'USA', 'AEHF': 'USA',
    'MUOS': 'USA', 'NOSS': 'USA', 'DMSP': 'USA', 'TIROS': 'USA',
    # Russia
    'COSMOS': 'RUS', 'KOSMOS': 'RUS', 'RESURS': 'RUS', 'METEOR': 'RUS',
    'GLONASS': 'RUS', 'ZARYA': 'RUS', 'NAUKA': 'RUS', 'PROGRESS': 'RUS',
    'SOYUZ': 'RUS', 'GONETS': 'RUS', 'LUCH': 'RUS', 'ELEKTRO': 'RUS',
    'KANOPUS': 'RUS', 'KONDOR': 'RUS', 'ARKTIKA': 'RUS', 'MERIDIAN': 'RUS',
    'MOLNIYA': 'RUS', 'PRICHAL': 'RUS', 'RASSVET': 'RUS',
    # China
    'BEIDOU': 'CHN', 'YAOGAN': 'CHN', 'SHIJIAN': 'CHN', 'TIANHE': 'CHN',
    'WENTIAN': 'CHN', 'MENGTIAN': 'CHN', 'CZ-': 'CHN', 'FENGYUN': 'CHN',
    'GAOFEN': 'CHN', 'JILIN': 'CHN', 'ZIYUAN': 'CHN', 'SHIYAN': 'CHN',
    'TIANLIAN': 'CHN', 'ZHONGXING': 'CHN',
    # India
    'IRNSS': 'IND', 'GSAT': 'IND', 'CARTOSAT': 'IND', 'RESOURCESAT': 'IND',
    'OCEANSAT': 'IND', 'RISAT': 'IND', 'INSAT': 'IND', 'ASTROSAT': 'IND',
    # Europe / ESA
    'GALILEO': 'EU', 'SENTINEL': 'EU', 'METEOSAT': 'EU', 'AEOLUS': 'EU',
    'CRYOSAT': 'EU', 'SWARM': 'EU', 'EUTELSAT': 'EU', 'ASTRA': 'EU',
    # Japan
    'QZSS': 'JPN', 'HIMAWARI': 'JPN', 'ALOS': 'JPN', 'GOSAT': 'JPN',
    'HAYABUSA': 'JPN', 'MICHIBIKI': 'JPN',
    # UK
    'ONEWEB': 'GBR',
    # South Korea
    'KOMPSAT': 'KOR', 'ARIRANG': 'KOR',
    # International
    'ISS': 'ISS',
}

OPERATOR_BY_NAME = {
    'STARLINK': 'SpaceX', 'FALCON': 'SpaceX', 'DRAGON': 'SpaceX',
    'ONEWEB': 'OneWeb', 'IRIDIUM': 'Iridium',
    'GLOBALSTAR': 'Globalstar', 'ORBCOMM': 'ORBCOMM',
    'GPS': 'US Space Force', 'NAVSTAR': 'US Space Force',
    'TDRS': 'NASA', 'TERRA': 'NASA', 'AQUA': 'NASA', 'LANDSAT': 'NASA/USGS',
    'GOES': 'NOAA', 'NOAA': 'NOAA', 'DMSP': 'US DoD', 'TIROS': 'NOAA',
    'GLONASS': 'Роскосмос', 'COSMOS': 'Роскосмос', 'KOSMOS': 'Роскосмос',
    'RESURS': 'Роскосмос', 'METEOR': 'Роскосмос', 'PROGRESS': 'Роскосмос',
    'SOYUZ': 'Роскосмос', 'ELEKTRO': 'Роскосмос', 'KANOPUS': 'Роскосмос',
    'BEIDOU': 'CNSA', 'YAOGAN': 'CNSA', 'FENGYUN': 'CMA/CNSA',
    'GAOFEN': 'CNSA', 'GALILEO': 'ESA/EU',
    'SENTINEL': 'ESA/Copernicus', 'METEOSAT': 'EUMETSAT',
    'HIMAWARI': 'JMA', 'QZSS': 'JAXA',
    'ISS': 'NASA/Роскосмос/ESA/JAXA/CSA',
    'IRNSS': 'ISRO', 'GSAT': 'ISRO', 'CARTOSAT': 'ISRO',
}


def detect_country(name: str) -> str:
    """Определяет страну спутника по названию."""
    upper = name.upper()
    for pattern, country in COUNTRY_BY_NAME.items():
        if pattern in upper:
            return country
    return ''


def detect_operator(name: str) -> str:
    """Определяет оператора спутника по названию."""
    upper = name.upper()
    for pattern, op in OPERATOR_BY_NAME.items():
        if pattern in upper:
            return op
    return ''

# Последнее время обновления
_last_update: datetime | None = None
_last_update_results: list = []


def get_last_update_info() -> Dict[str, Any]:
    """Возвращает информацию о последнем обновлении."""
    return {
        "last_update": _last_update.isoformat() if _last_update else None,
        "results": _last_update_results,
    }


def fetch_tle_from_celestrak(group: str) -> str:
    """Загружает TLE-данные с Celestrak для конкретной группы."""
    params = {"GROUP": group, "FORMAT": "tle"}
    response = requests.get(CELESTRAK_URL, params=params, timeout=30)
    response.raise_for_status()
    response.encoding = "utf-8"
    return response.text


def parse_raw_tle_blocks(text: str):
    """
    Парсит сырой TLE-текст в список блоков (name, line1, line2).
    Возвращает список кортежей.
    """
    lines = [l.rstrip() for l in text.strip().splitlines() if l.strip()]
    blocks = []
    i = 0
    while i < len(lines):
        if (
            i + 2 < len(lines)
            and lines[i + 1].startswith("1 ")
            and lines[i + 2].startswith("2 ")
        ):
            blocks.append((lines[i].strip(), lines[i + 1].strip(), lines[i + 2].strip()))
            i += 3
        elif (
            lines[i].startswith("1 ")
            and i + 1 < len(lines)
            and lines[i + 1].startswith("2 ")
        ):
            name = f"NORAD-{lines[i][2:7].strip()}"
            blocks.append((name, lines[i].strip(), lines[i + 1].strip()))
            i += 2
        else:
            i += 1
    return blocks


def update_tle_group(db: Session, group: str) -> Dict[str, Any]:
    """Загружает TLE для группы и upsert в БД."""
    try:
        tle_text = fetch_tle_from_celestrak(group)
        blocks = parse_raw_tle_blocks(tle_text)

        added = 0
        updated = 0
        errors = 0

        for name, line1, line2 in blocks:
            try:
                norad_id = int(line1[2:7].strip())

                # Парсим через skyfield для расчёта параметров
                sat_obj = parse_tle(name, line1, line2)
                pos = get_position(sat_obj)

                # Upsert
                existing = db.query(Satellite).filter(
                    Satellite.norad_id == norad_id
                ).first()

                country = detect_country(name)
                operator = detect_operator(name)

                if existing:
                    existing.name = name
                    existing.tle_line1 = line1
                    existing.tle_line2 = line2
                    existing.group = group
                    existing.orbit_type = pos["orbit_type"]
                    existing.inclination = pos["inclination_deg"]
                    existing.eccentricity = pos["eccentricity"]
                    existing.mean_motion = pos["mean_motion"]
                    existing.country = country or existing.country
                    existing.operator = operator or existing.operator
                    updated += 1
                else:
                    sat = Satellite(
                        norad_id=norad_id,
                        name=name,
                        tle_line1=line1,
                        tle_line2=line2,
                        group=group,
                        orbit_type=pos["orbit_type"],
                        inclination=pos["inclination_deg"],
                        eccentricity=pos["eccentricity"],
                        mean_motion=pos["mean_motion"],
                        country=country,
                        operator=operator,
                    )
                    db.add(sat)
                    added += 1
            except Exception as e:
                errors += 1
                continue

        db.commit()
        result = {
            "group": group,
            "added": added,
            "updated": updated,
            "errors": errors,
            "total": len(blocks),
        }
        logger.info(f"[TLE] {group}: +{added} / ~{updated} / err={errors}")
        return result

    except requests.exceptions.RequestException as e:
        logger.error(f"[TLE] Failed to fetch {group}: {e}")
        return {"group": group, "error": str(e)}


def update_all_groups(groups: List[str] | None = None) -> List[Dict[str, Any]]:
    """
    Обновляет все сконфигурированные группы TLE.
    Вызывается при старте и по расписанию (раз в сутки).
    """
    global _last_update, _last_update_results

    if groups is None:
        groups = settings.tle_groups_list

    results = []
    db = SessionLocal()
    try:
        for group in groups:
            result = update_tle_group(db, group)
            results.append(result)
            logger.info(f"[TLE] Updated group '{group}': {result}")
    finally:
        db.close()

    _last_update = datetime.now(timezone.utc)
    _last_update_results = results
    return results
