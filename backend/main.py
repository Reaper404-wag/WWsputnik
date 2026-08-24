"""
main.py — Точка входа FastAPI-приложения.

Запуск:
    py -3.12 -m uvicorn backend.main:app --reload --port 8002
    или
    py -3.12 -m uvicorn backend.main:app --host 0.0.0.0 --port 8002

Swagger UI: http://localhost:8002/docs
"""

import os
import logging
import threading
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.config import get_settings
from backend.database import create_tables
from backend.routers import satellites, passes, auth, tle, favorites, chat

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

settings = get_settings()


def initial_tle_update():
    """Фоновая загрузка TLE-данных при старте (в отдельном потоке)."""
    try:
        from backend.services.tle_updater import update_all_groups
        logger.info("[STARTUP] Starting TLE data fetch...")
        results = update_all_groups()
        total = sum(r.get("added", 0) + r.get("updated", 0) for r in results)
        logger.info(f"[STARTUP] TLE update complete: {total} satellites loaded")
    except Exception as e:
        logger.error(f"[STARTUP] TLE update failed: {e}")


def init_roles_and_admin():
    """Создать дефолтные роли и admin-пользователя при первом запуске."""
    from backend.database import SessionLocal
    from backend.services.auth_service import (
        get_or_create_role, get_user_by_username, hash_password
    )
    from backend.models.user import User as DBUser

    db = SessionLocal()
    try:
        # Создать роли
        get_or_create_role(db, "user", "Обычный пользователь")
        get_or_create_role(db, "leader", "Руководитель")
        admin_role = get_or_create_role(db, "admin", "Администратор")

        # Создать admin, если не существует
        admin = get_user_by_username(db, "admin")
        if not admin:
            admin = DBUser(
                username="admin",
                email="admin@sputnik.local",
                full_name="Администратор",
                hashed_password=hash_password("admin"),
            )
            admin.roles.append(admin_role)
            db.add(admin)
            db.commit()
            logger.info("[STARTUP] Admin user created (admin/admin)")
        else:
            logger.info("[STARTUP] Admin user already exists")
    except Exception as e:
        logger.error(f"[STARTUP] Roles/admin init failed: {e}")
        db.rollback()
    finally:
        db.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown lifecycle."""
    # 1. Create DB tables
    create_tables()
    logger.info(f"[OK] DB initialized: {settings.DATABASE_URL}")

    # 2. Init roles and admin user
    init_roles_and_admin()

    # 3. Create TLE cache directory
    os.makedirs(settings.TLE_DATA_DIR, exist_ok=True)

    # 4. Start TLE update in background thread (non-blocking)
    update_thread = threading.Thread(target=initial_tle_update, daemon=True)
    update_thread.start()

    yield

    logger.info("[STOP] Application shutdown")


app = FastAPI(
    title=settings.APP_TITLE,
    version=settings.APP_VERSION,
    description=(
        "API Sputnik — Satellite Monitoring Platform. "
        "Orbital calculations via SGP4/Skyfield."
    ),
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan,
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        *settings.cors_origins_list,
        "http://localhost:5500",
        "http://127.0.0.1:5500",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routers
app.include_router(satellites.router)
app.include_router(passes.router)
app.include_router(auth.router)
app.include_router(tle.router)
app.include_router(favorites.router)
app.include_router(chat.router)


@app.get("/health", tags=["System"])
async def health_check():
    return {
        "status": "ok",
        "app": settings.APP_TITLE,
        "version": settings.APP_VERSION,
    }


@app.get("/", tags=["System"])
async def root():
    return {
        "message": "Sputnik API",
        "docs": "/docs",
        "health": "/health",
    }
