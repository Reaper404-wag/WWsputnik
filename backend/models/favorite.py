"""
models/favorite.py — Избранные спутники пользователя.

Связывает пользователя с NORAD ID спутника.
"""

from datetime import datetime
from sqlalchemy import String, Integer, DateTime, ForeignKey, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship
from backend.database import Base


class Favorite(Base):
    __tablename__ = "favorites"
    __table_args__ = (
        UniqueConstraint("user_id", "norad_id", name="uq_user_satellite"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)

    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    norad_id: Mapped[int] = mapped_column(Integer, index=True)
    satellite_name: Mapped[str] = mapped_column(String(100))

    added_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now()
    )

    user: Mapped["User"] = relationship("User", back_populates="favorites")  # noqa: F821

    def __repr__(self) -> str:
        return f"<Favorite user={self.user_id} sat={self.norad_id}>"
