"""
models/satellite.py — Модель спутника в БД.

Хранит TLE-данные и метаинформацию о спутнике.
Координаты НЕ хранятся — они вычисляются на лету через sgp4_service.
"""

from datetime import datetime
from sqlalchemy import String, Integer, Float, DateTime, ForeignKey, func
from sqlalchemy.orm import Mapped, mapped_column
from backend.database import Base


class Satellite(Base):
    __tablename__ = "satellites"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)

    # --- TLE-данные ---
    norad_id: Mapped[int] = mapped_column(Integer, unique=True, index=True)
    name: Mapped[str] = mapped_column(String(100), index=True)
    tle_line1: Mapped[str] = mapped_column(String(70))
    tle_line2: Mapped[str] = mapped_column(String(70))

    # --- Группа (источник загрузки: stations, military, weather...) ---
    group: Mapped[str] = mapped_column(String(50), index=True, default="unknown")

    # --- Метаданные (вычисляются при парсинге TLE) ---
    country: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)
    operator: Mapped[str | None] = mapped_column(String(150), nullable=True)
    orbit_type: Mapped[str | None] = mapped_column(String(20), nullable=True)
    # LEO / MEO / GEO / HEO — определяется по высоте

    inclination: Mapped[float | None] = mapped_column(Float, nullable=True)
    eccentricity: Mapped[float | None] = mapped_column(Float, nullable=True)
    mean_motion: Mapped[float | None] = mapped_column(Float, nullable=True)
    # mean_motion в об/день → period = 1440 / mean_motion (мин)

    # --- Владелец (для пользовательских спутников из загруженных TLE) ---
    owner_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("users.id"), nullable=True, default=None
    )

    # --- Временные метки ---
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    def __repr__(self) -> str:
        return f"<Satellite {self.norad_id} '{self.name}' [{self.group}]>"
