"""
routers/favorites.py — Избранные спутники пользователя.

Эндпоинты:
  GET    /favorites/          — Список избранного текущего пользователя
  POST   /favorites/{norad_id} — Добавить спутник в избранное
  DELETE /favorites/{norad_id} — Удалить из избранного
  GET    /favorites/check/{norad_id} — Проверить, в избранном ли спутник
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.models.user import User as DBUser
from backend.models.favorite import Favorite
from backend.models.satellite import Satellite
from backend.services.auth_service import get_current_active_user

router = APIRouter(prefix="/favorites", tags=["Favorites"])


class FavoriteResponse(BaseModel):
    norad_id: int
    satellite_name: str
    added_at: str

    class Config:
        from_attributes = True


@router.get("/", response_model=list[FavoriteResponse])
async def list_favorites(
    db: Session = Depends(get_db),
    user: DBUser = Depends(get_current_active_user),
):
    """Список избранных спутников текущего пользователя."""
    favs = db.query(Favorite).filter(Favorite.user_id == user.id).order_by(Favorite.added_at.desc()).all()
    return [
        FavoriteResponse(
            norad_id=f.norad_id,
            satellite_name=f.satellite_name,
            added_at=f.added_at.isoformat() if f.added_at else "",
        )
        for f in favs
    ]


@router.post("/{norad_id}", status_code=201)
async def add_favorite(
    norad_id: int,
    db: Session = Depends(get_db),
    user: DBUser = Depends(get_current_active_user),
):
    """Добавить спутник в избранное."""
    # Проверить, существует ли спутник
    sat = db.query(Satellite).filter(Satellite.norad_id == norad_id).first()
    if not sat:
        raise HTTPException(status_code=404, detail="Спутник не найден")

    # Проверить дубликат
    existing = db.query(Favorite).filter(
        Favorite.user_id == user.id, Favorite.norad_id == norad_id
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail="Уже в избранном")

    fav = Favorite(
        user_id=user.id,
        norad_id=norad_id,
        satellite_name=sat.name,
    )
    db.add(fav)
    db.commit()
    return {"status": "added", "norad_id": norad_id, "name": sat.name}


@router.delete("/{norad_id}")
async def remove_favorite(
    norad_id: int,
    db: Session = Depends(get_db),
    user: DBUser = Depends(get_current_active_user),
):
    """Удалить спутник из избранного."""
    fav = db.query(Favorite).filter(
        Favorite.user_id == user.id, Favorite.norad_id == norad_id
    ).first()
    if not fav:
        raise HTTPException(status_code=404, detail="Не найден в избранном")

    db.delete(fav)
    db.commit()
    return {"status": "removed", "norad_id": norad_id}


@router.get("/check/{norad_id}")
async def check_favorite(
    norad_id: int,
    db: Session = Depends(get_db),
    user: DBUser = Depends(get_current_active_user),
):
    """Проверить, в избранном ли спутник."""
    fav = db.query(Favorite).filter(
        Favorite.user_id == user.id, Favorite.norad_id == norad_id
    ).first()
    return {"is_favorite": fav is not None, "norad_id": norad_id}
