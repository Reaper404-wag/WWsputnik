"""
routers/tle.py — Управление TLE-данными.

Эндпоинты:
  POST /tle/update        — ручной триггер обновления с Celestrak
  GET  /tle/status        — статус последнего обновления
  GET  /tle/groups        — список доступных групп
"""

from fastapi import APIRouter, BackgroundTasks
from backend.services.tle_updater import update_all_groups, get_last_update_info
from backend.config import get_settings

settings = get_settings()
router = APIRouter(prefix="/tle", tags=["TLE"])


@router.get("/status")
async def tle_status():
    """Статус последнего обновления TLE-данных."""
    info = get_last_update_info()
    return {
        "status": "ok" if info["last_update"] else "no_data",
        **info,
    }


@router.post("/update")
async def tle_update(background_tasks: BackgroundTasks):
    """Запустить обновление TLE-данных в фоне."""
    background_tasks.add_task(update_all_groups)
    return {"status": "started", "groups": settings.tle_groups_list}


@router.get("/groups")
async def tle_groups():
    """Список доступных TLE-групп."""
    return {"groups": settings.tle_groups_list}
