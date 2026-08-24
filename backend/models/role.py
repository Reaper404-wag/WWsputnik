"""
models/role.py — Модель ролей и промежуточная таблица user_roles.

Роли: user, admin. Связь many-to-many с User.
"""

from sqlalchemy import String, Integer, Column, Table, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column, relationship
from backend.database import Base


# Промежуточная таблица many-to-many
user_roles = Table(
    "user_roles",
    Base.metadata,
    Column("user_id", Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    Column("role_id", Integer, ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True),
)


class Role(Base):
    __tablename__ = "roles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(50), unique=True, index=True)
    description: Mapped[str] = mapped_column(String(255), default="")

    users: Mapped[list["User"]] = relationship(  # noqa: F821
        "User", secondary=user_roles, back_populates="roles"
    )

    def __repr__(self) -> str:
        return f"<Role {self.id} '{self.name}'>"
