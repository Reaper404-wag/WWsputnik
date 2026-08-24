"""
models/user.py — Модель пользователя.

Хранит учётные данные, роли и связана с историей пролётов.
"""

from datetime import datetime
from sqlalchemy import String, Integer, Boolean, DateTime, func
from sqlalchemy.orm import Mapped, mapped_column, relationship
from backend.database import Base
from backend.models.role import user_roles


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    username: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(255), default="")
    hashed_password: Mapped[str] = mapped_column(String(255))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    email_confirmed: Mapped[bool] = mapped_column(Boolean, default=False)

    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now()
    )

    # Связь с ролями (many-to-many)
    roles: Mapped[list["Role"]] = relationship(  # noqa: F821
        "Role", secondary=user_roles, back_populates="users", lazy="joined"
    )

    # Связь с историей пролётов (lazy загрузка)
    pass_history: Mapped[list["PassHistory"]] = relationship(  # noqa: F821
        "PassHistory", back_populates="user", cascade="all, delete-orphan"
    )

    # Связь с избранными спутниками
    favorites: Mapped[list["Favorite"]] = relationship(  # noqa: F821
        "Favorite", back_populates="user", cascade="all, delete-orphan"
    )

    def has_role(self, role_name: str) -> bool:
        """Проверить, есть ли у пользователя указанная роль."""
        return any(r.name == role_name for r in self.roles)

    def __repr__(self) -> str:
        return f"<User {self.id} '{self.username}'>"
