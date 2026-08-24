"""
routers/satellites.py — Эндпоинты для работы со спутниками.

  GET  /satellites/            — список с фильтрами + текущие координаты
  GET  /satellites/countries   — список стран для фильтра
  GET  /satellites/{norad_id}  — карточка спутника + позиция
  GET  /satellites/{norad_id}/track — орбитальный трек
  POST /satellites/import-tle  — импорт TLE из файла (привязка к пользователю)
  GET  /satellites/my          — спутники текущего пользователя
  DELETE /satellites/my/{norad_id} — удалить пользовательский спутник
"""

from typing import Optional
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, Query, HTTPException, UploadFile, File
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.models.satellite import Satellite
from backend.models.user import User as DBUser
from backend.services.tle_parser import parse_tle
from backend.services.sgp4_service import get_position, get_track, classify_orbit
from backend.services.auth_service import get_current_active_user
from backend.services.tle_updater import parse_raw_tle_blocks, detect_country, detect_operator

router = APIRouter(prefix="/satellites", tags=["Satellites"])


@router.get("/countries")
async def list_countries(db: Session = Depends(get_db)):
    """Список уникальных стран для фильтра."""
    rows = db.query(Satellite.country).filter(
        Satellite.country.isnot(None), Satellite.country != ''
    ).distinct().all()
    countries = sorted([r[0] for r in rows])
    return {"countries": countries}


@router.get("/my")
async def my_satellites(
    db: Session = Depends(get_db),
    current_user: DBUser = Depends(get_current_active_user),
):
    """Спутники, загруженные текущим пользователем."""
    sats = db.query(Satellite).filter(Satellite.owner_id == current_user.id).all()
    return {
        "count": len(sats),
        "satellites": [
            {
                "norad_id": s.norad_id, "name": s.name, "group": s.group,
                "country": s.country, "operator": s.operator,
                "orbit_type": s.orbit_type,
                "tle_line1": s.tle_line1, "tle_line2": s.tle_line2,
            }
            for s in sats
        ],
    }


@router.get("/")
async def list_satellites(
    group: Optional[str] = Query(None, description="Фильтр по группе (stations, military...)"),
    orbit_type: Optional[str] = Query(None, description="Фильтр по типу орбиты (LEO, MEO, GEO, HEO)"),
    country: Optional[str] = Query(None, description="Фильтр по стране (USA, RUS, CHN...)"),
    search: Optional[str] = Query(None, description="Поиск по названию"),
    limit: int = Query(200, ge=1, le=15000),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    """
    Список спутников с текущими координатами.
    Поддерживает фильтрацию по группе, типу орбиты, стране и поиску по имени.
    """
    query = db.query(Satellite)

    if group:
        query = query.filter(Satellite.group == group)
    if orbit_type:
        query = query.filter(Satellite.orbit_type == orbit_type)
    if country:
        query = query.filter(Satellite.country == country)
    if search:
        query = query.filter(Satellite.name.ilike(f"%{search}%"))

    total = query.count()
    satellites = query.offset(offset).limit(limit).all()

    # Вычисляем текущие координаты для каждого спутника
    results = []
    now = datetime.now(timezone.utc)

    for sat in satellites:
        try:
            sat_obj = parse_tle(sat.name, sat.tle_line1, sat.tle_line2)
            pos = get_position(sat_obj, now)
            results.append({
                "norad_id": sat.norad_id,
                "name": sat.name,
                "group": sat.group,
                "country": sat.country,
                "operator": sat.operator,
                "orbit_type": sat.orbit_type or pos["orbit_type"],
                "lat": pos["lat"],
                "lon": pos["lon"],
                "altitude_km": pos["altitude_km"],
                "velocity_km_s": pos["velocity_km_s"],
                "period_minutes": pos["period_minutes"],
                "inclination_deg": pos["inclination_deg"],
                "eccentricity": pos["eccentricity"],
            })
        except Exception:
            results.append({
                "norad_id": sat.norad_id,
                "name": sat.name,
                "group": sat.group,
                "country": sat.country,
                "operator": sat.operator,
                "orbit_type": sat.orbit_type,
                "lat": None,
                "lon": None,
                "altitude_km": None,
                "error": "sgp4_calculation_failed",
            })

    return {
        "total": total,
        "count": len(results),
        "timestamp": now.isoformat(),
        "satellites": results,
    }


@router.get("/tle-data")
async def get_tle_data(
    group: Optional[str] = Query(None),
    limit: int = Query(200, ge=1, le=15000),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    """TLE-данные для клиентского SGP4 (satellite.js)."""
    query = db.query(Satellite)
    if group:
        query = query.filter(Satellite.group == group)
    total = query.count()
    satellites = query.offset(offset).limit(limit).all()
    return {
        "total": total,
        "satellites": [
            {
                "norad_id": s.norad_id,
                "name": s.name,
                "group": s.group,
                "orbit_type": s.orbit_type,
                "country": s.country,
                "operator": s.operator,
                "tle_line1": s.tle_line1,
                "tle_line2": s.tle_line2,
            }
            for s in satellites
        ],
    }


@router.get("/{norad_id}")
async def get_satellite(norad_id: int, db: Session = Depends(get_db)):
    """Карточка спутника — полная информация + текущая позиция."""
    sat = db.query(Satellite).filter(Satellite.norad_id == norad_id).first()
    if not sat:
        raise HTTPException(status_code=404, detail=f"Satellite {norad_id} not found")

    try:
        sat_obj = parse_tle(sat.name, sat.tle_line1, sat.tle_line2)
        pos = get_position(sat_obj)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"SGP4 error: {e}")

    return {
        "norad_id": sat.norad_id,
        "name": sat.name,
        "group": sat.group,
        "country": sat.country,
        **pos,
    }


@router.get("/{norad_id}/track")
async def get_satellite_track(
    norad_id: int,
    minutes: int = Query(90, ge=10, le=360),
    steps: int = Query(180, ge=20, le=720),
    db: Session = Depends(get_db),
):
    """Орбитальный трек спутника — массив точек для отрисовки на карте."""
    sat = db.query(Satellite).filter(Satellite.norad_id == norad_id).first()
    if not sat:
        raise HTTPException(status_code=404, detail=f"Satellite {norad_id} not found")

    try:
        sat_obj = parse_tle(sat.name, sat.tle_line1, sat.tle_line2)
        track = get_track(sat_obj, minutes=minutes, steps=steps)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"SGP4 error: {e}")

    return {
        "norad_id": sat.norad_id,
        "name": sat.name,
        "minutes": minutes,
        "steps": steps,
        "track": track,
    }


@router.post("/import-tle")
async def import_tle(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: DBUser = Depends(get_current_active_user),
):
    """
    Импорт TLE из .txt файла. Спутники привязываются к пользователю.
    Формат: стандартный TLE (name + line1 + line2 блоки).
    """
    if not file.filename.endswith(('.txt', '.tle')):
        raise HTTPException(status_code=400, detail="Поддерживаются только .txt и .tle файлы")

    content = await file.read()
    try:
        text = content.decode('utf-8')
    except UnicodeDecodeError:
        text = content.decode('latin-1')

    blocks = parse_raw_tle_blocks(text)
    if not blocks:
        raise HTTPException(status_code=400, detail="Не найдено TLE-данных в файле")

    added = 0
    updated = 0
    errors = 0
    now = datetime.now(timezone.utc)

    for name, line1, line2 in blocks:
        try:
            norad_id = int(line1[2:7].strip())
            sat_obj = parse_tle(name, line1, line2)
            pos = get_position(sat_obj, now)
            country = detect_country(name)
            operator = detect_operator(name)

            existing = db.query(Satellite).filter(Satellite.norad_id == norad_id).first()
            if existing:
                if existing.owner_id == current_user.id:
                    # Свой спутник — обновляем полностью
                    existing.name = name
                    existing.tle_line1 = line1
                    existing.tle_line2 = line2
                    existing.orbit_type = pos["orbit_type"]
                    existing.inclination = pos["inclination_deg"]
                    existing.eccentricity = pos["eccentricity"]
                    existing.mean_motion = pos["mean_motion"]
                    existing.country = country or existing.country
                    existing.operator = operator or existing.operator
                    updated += 1
                elif existing.owner_id is None:
                    # Системный спутник — обновляем только TLE, не забираем
                    existing.tle_line1 = line1
                    existing.tle_line2 = line2
                    existing.orbit_type = pos["orbit_type"]
                    existing.inclination = pos["inclination_deg"]
                    existing.eccentricity = pos["eccentricity"]
                    existing.mean_motion = pos["mean_motion"]
                    updated += 1
                else:
                    # Чужой спутник — пропускаем
                    errors += 1
            else:
                sat = Satellite(
                    norad_id=norad_id,
                    name=name,
                    tle_line1=line1,
                    tle_line2=line2,
                    group="custom",
                    orbit_type=pos["orbit_type"],
                    inclination=pos["inclination_deg"],
                    eccentricity=pos["eccentricity"],
                    mean_motion=pos["mean_motion"],
                    country=country,
                    operator=operator,
                    owner_id=current_user.id,
                )
                db.add(sat)
                added += 1
        except Exception:
            errors += 1

    db.commit()
    return {
        "status": "ok",
        "added": added,
        "updated": updated,
        "errors": errors,
        "total_in_file": len(blocks),
    }


@router.delete("/my/{norad_id}")
async def delete_my_satellite(
    norad_id: int,
    db: Session = Depends(get_db),
    current_user: DBUser = Depends(get_current_active_user),
):
    """Удалить пользовательский спутник."""
    sat = db.query(Satellite).filter(
        Satellite.norad_id == norad_id,
        Satellite.owner_id == current_user.id,
    ).first()
    if not sat:
        raise HTTPException(status_code=404, detail="Спутник не найден или не принадлежит вам")
    db.delete(sat)
    db.commit()
    return {"status": "ok", "norad_id": norad_id}
