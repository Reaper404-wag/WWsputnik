"""
database.py — Подключение к БД через SQLAlchemy 2.0.

Использует SQLite (локально). Для миграции на PostgreSQL
достаточно сменить DATABASE_URL в .env.
"""

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase
from backend.config import get_settings

settings = get_settings()

# --- Engine ---
# check_same_thread=False нужен для SQLite + FastAPI (многопоточность)
engine = create_engine(
    settings.DATABASE_URL,
    connect_args={"check_same_thread": False} if "sqlite" in settings.DATABASE_URL else {},
    echo=settings.DEBUG,  # в DEBUG-режиме логирует все SQL-запросы
)

# --- Session factory ---
SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine,
)


# --- Base для всех моделей ---
class Base(DeclarativeBase):
    """Базовый класс. Все модели наследуются от него."""
    pass


# --- Dependency для FastAPI роутеров ---
def get_db():
    """
    Генератор сессии БД.
    Использование в роутерах: db: Session = Depends(get_db)
    Гарантирует закрытие сессии после запроса.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def create_tables() -> None:
    """
    Создаёт все таблицы в БД на основе моделей.
    Вызывается при старте приложения (lifespan).
    """
    # Импортируем все модели, чтобы они зарегистрировались в Base.metadata
    from backend.models import satellite, user, pass_history, role, favorite, email_token, chat_message  # noqa: F401
    Base.metadata.create_all(bind=engine)
