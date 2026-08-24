"""
config.py — Настройки приложения через pydantic-settings.
Все переменные читаются из .env файла или окружения.
"""

from pydantic_settings import BaseSettings, SettingsConfigDict
from functools import lru_cache


class Settings(BaseSettings):
    # --- Приложение ---
    APP_TITLE: str = "Sputnik — Мониторинг спутников"
    APP_VERSION: str = "0.1.0"
    DEBUG: bool = False

    # --- База данных ---
    DATABASE_URL: str = "sqlite:///./sputnik.db"

    # --- JWT ---
    SECRET_KEY: str = "change-me-in-production"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24  # 24 часа

    # --- CORS ---
    # Список разрешённых origins, разделённых запятой
    CORS_ORIGINS: str = "http://localhost:5173,http://localhost:3000"

    # --- TLE-обновление ---
    TLE_UPDATE_INTERVAL_SECONDS: int = 86400  # раз в сутки
    TLE_DATA_DIR: str = "DATA/tle"

    # Группы спутников для загрузки с Celestrak
    TLE_GROUPS: str = "stations,military,weather,resource,starlink,oneweb"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
    )

    @property
    def cors_origins_list(self) -> list[str]:
        """Возвращает список CORS origins из строки."""
        return [origin.strip() for origin in self.CORS_ORIGINS.split(",")]

    @property
    def tle_groups_list(self) -> list[str]:
        """Возвращает список TLE-групп из строки."""
        return [group.strip() for group in self.TLE_GROUPS.split(",")]


@lru_cache()
def get_settings() -> Settings:
    """
    Синглтон настроек — вызывается через Depends(get_settings) в роутерах.
    lru_cache гарантирует, что .env читается один раз.
    """
    return Settings()
