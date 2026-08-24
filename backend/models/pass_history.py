"""
models/pass_history.py — История пролётов спутников над точкой.

Сохраняется для каждого авторизованного пользователя
при запросе пролётов через /passes.
"""

from datetime import datetime
from sqlalchemy import String, Integer, Float, DateTime, ForeignKey, func
from sqlalchemy.orm import Mapped, mapped_column, relationship
from backend.database import Base


class PassHistory(Base):
    __tablename__ = "pass_history"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)

    # Пользователь, который сделал запрос
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )

    # Спутник (храним norad_id напрямую — спутник могут удалить/обновить)
    norad_id: Mapped[int] = mapped_column(Integer, index=True)
    satellite_name: Mapped[str] = mapped_column(String(100))

    # Точка наблюдения
    observer_lat: Mapped[float] = mapped_column(Float)
    observer_lon: Mapped[float] = mapped_column(Float)
    observer_name: Mapped[str | None] = mapped_column(String(100), nullable=True)

    # Параметры пролёта
    rise_time: Mapped[datetime] = mapped_column(DateTime)      # начало пролёта
    max_elevation: Mapped[float | None] = mapped_column(Float, nullable=True)  # градусы
    set_time: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)  # конец

    # Когда был сделан запрос
    queried_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now()
    )

    # Обратная связь
    user: Mapped["User"] = relationship("User", back_populates="pass_history")  # noqa: F821

    def __repr__(self) -> str:
        return (
            f"<PassHistory user={self.user_id} sat={self.norad_id} "
            f"rise={self.rise_time}>"
        )
