"""
routers/passes.py — Пролёты спутников над точкой наблюдения.

Эндпоинты:
  GET /passes/ — Расчёт пролётов спутников над заданными координатами
  GET /passes/region — Пролёты над предустановленными регионами
"""

from typing import Optional
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.models.satellite import Satellite
from backend.models.pass_history import PassHistory
from backend.models.user import User as DBUser
from backend.services.tle_parser import parse_tle
from backend.services.pass_service import find_passes
from backend.services.auth_service import get_current_active_user, get_current_user, oauth2_scheme

router = APIRouter(prefix="/passes", tags=["Passes"])

# Предустановленные регионы
REGIONS = {
    # Россия
    "moscow": {"name": "Москва", "lat": 55.7558, "lon": 37.6173},
    "rostov": {"name": "Ростов-на-Дону", "lat": 47.2357, "lon": 39.7015},
    "spb": {"name": "Санкт-Петербург", "lat": 59.9343, "lon": 30.3351},
    "novosibirsk": {"name": "Новосибирск", "lat": 55.0084, "lon": 82.9357},
    "vladivostok": {"name": "Владивосток", "lat": 43.1155, "lon": 131.8855},
    "ekaterinburg": {"name": "Екатеринбург", "lat": 56.8389, "lon": 60.6057},
    "kazan": {"name": "Казань", "lat": 55.7887, "lon": 49.1221},
    "murmansk": {"name": "Мурманск", "lat": 68.9585, "lon": 33.0827},
    "kaliningrad": {"name": "Калининград", "lat": 54.7104, "lon": 20.4522},
    "sochi": {"name": "Сочи", "lat": 43.6028, "lon": 39.7342},
    "krasnodar": {"name": "Краснодар", "lat": 45.0355, "lon": 38.9753},
    # Мир
    "washington": {"name": "Вашингтон", "lat": 38.9072, "lon": -77.0369},
    "beijing": {"name": "Пекин", "lat": 39.9042, "lon": 116.4074},
    "delhi": {"name": "Дели", "lat": 28.6139, "lon": 77.2090},
    "london": {"name": "Лондон", "lat": 51.5074, "lon": -0.1278},
    "tokyo": {"name": "Токио", "lat": 35.6762, "lon": 139.6503},
    "sydney": {"name": "Сидней", "lat": -33.8688, "lon": 151.2093},
    "saopaulo": {"name": "Сан-Паулу", "lat": -23.5505, "lon": -46.6333},
    "cape_town": {"name": "Кейптаун", "lat": -33.9249, "lon": 18.4241},
}


@router.get("/regions")
async def list_regions():
    """Список предустановленных регионов."""
    return REGIONS


@router.get("/")
async def get_passes(
    lat: float = Query(..., ge=-90, le=90, description="Широта наблюдателя"),
    lon: float = Query(..., ge=-180, le=180, description="Долгота наблюдателя"),
    norad_id: Optional[int] = Query(None, description="NORAD ID конкретного спутника"),
    group: Optional[str] = Query(None, description="Группа спутников"),
    hours: int = Query(24, ge=1, le=72, description="Окно поиска (часы)"),
    min_elevation: float = Query(10.0, ge=0, le=90, description="Мин. элевация (градусы)"),
    limit: int = Query(20, ge=1, le=100, description="Макс. число спутников для расчёта"),
    db: Session = Depends(get_db),
):
    """
    Расчёт ближайших пролётов спутников над точкой.
    Если указан norad_id — пролёты одного спутника.
    Если указан group — пролёты спутников из группы.
    Без фильтров — пролёты по всем (первые `limit` по алфавиту).
    """
    query = db.query(Satellite)

    if norad_id:
        query = query.filter(Satellite.norad_id == norad_id)
    elif group:
        query = query.filter(Satellite.group == group)

    satellites = query.limit(limit).all()
    if not satellites:
        raise HTTPException(status_code=404, detail="Спутники не найдены")

    results = []

    for sat in satellites:
        try:
            sat_obj = parse_tle(sat.name, sat.tle_line1, sat.tle_line2)
            passes = find_passes(
                sat_obj,
                observer_lat=lat,
                observer_lon=lon,
                hours=hours,
                min_elevation=min_elevation,
            )
            if passes:
                results.append({
                    "norad_id": sat.norad_id,
                    "name": sat.name,
                    "group": sat.group,
                    "orbit_type": sat.orbit_type,
                    "passes": passes,
                })
        except Exception:
            continue

    # Сортируем по времени ближайшего пролёта
    results.sort(key=lambda r: r["passes"][0]["rise_time"] if r["passes"] else "9999")

    return {
        "observer": {"lat": lat, "lon": lon},
        "hours": hours,
        "min_elevation": min_elevation,
        "total_satellites_checked": len(satellites),
        "satellites_with_passes": len(results),
        "results": results,
    }


@router.get("/region/{region_key}")
async def get_passes_by_region(
    region_key: str,
    group: Optional[str] = Query(None),
    hours: int = Query(24, ge=1, le=72),
    min_elevation: float = Query(10.0, ge=0, le=90),
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
):
    """Пролёты над предустановленным регионом."""
    region = REGIONS.get(region_key)
    if not region:
        raise HTTPException(
            status_code=404,
            detail=f"Регион '{region_key}' не найден. Доступные: {list(REGIONS.keys())}",
        )

    query = db.query(Satellite)
    if group:
        query = query.filter(Satellite.group == group)
    satellites = query.limit(limit).all()

    results = []
    for sat in satellites:
        try:
            sat_obj = parse_tle(sat.name, sat.tle_line1, sat.tle_line2)
            passes = find_passes(
                sat_obj,
                observer_lat=region["lat"],
                observer_lon=region["lon"],
                hours=hours,
                min_elevation=min_elevation,
            )
            if passes:
                results.append({
                    "norad_id": sat.norad_id,
                    "name": sat.name,
                    "group": sat.group,
                    "orbit_type": sat.orbit_type,
                    "passes": passes,
                })
        except Exception:
            continue

    results.sort(key=lambda r: r["passes"][0]["rise_time"] if r["passes"] else "9999")

    return {
        "region": region,
        "region_key": region_key,
        "hours": hours,
        "min_elevation": min_elevation,
        "total_satellites_checked": len(satellites),
        "satellites_with_passes": len(results),
        "results": results,
    }
