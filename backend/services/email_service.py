"""
services/email_service.py — Отправка email (SMTP или console fallback).

Если SMTP настроен (.env) — отправляет реальные письма.
Если нет — логирует в консоль сервера (для демонстрации).
"""

import os
import logging
import smtplib
import secrets
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.orm import Session

from backend.models.email_token import EmailToken
from backend.models.user import User as DBUser
from backend.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

# SMTP config from environment
SMTP_HOST = os.getenv("SMTP_HOST", "")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
SMTP_FROM = os.getenv("SMTP_FROM", SMTP_USER)
SMTP_ENABLED = bool(SMTP_HOST and SMTP_USER and SMTP_PASSWORD)

# Frontend URL for links in emails
FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:5500")

TOKEN_EXPIRY_HOURS = 24
RESET_EXPIRY_HOURS = 1


def generate_token() -> str:
    """Генерация криптостойкого токена."""
    return secrets.token_urlsafe(32)


def create_email_token(db: Session, user: DBUser, token_type: str) -> str:
    """
    Создать токен подтверждения/сброса и сохранить в БД.
    Удаляет старые токены того же типа для пользователя.
    """
    # Удалить старые токены этого типа
    db.query(EmailToken).filter(
        EmailToken.user_id == user.id,
        EmailToken.token_type == token_type,
    ).delete()
    db.flush()

    token = generate_token()
    expiry_hours = RESET_EXPIRY_HOURS if token_type == "reset" else TOKEN_EXPIRY_HOURS

    db_token = EmailToken(
        user_id=user.id,
        token=token,
        token_type=token_type,
        expires_at=datetime.now(timezone.utc) + timedelta(hours=expiry_hours),
    )
    db.add(db_token)
    db.commit()
    return token


def verify_token(db: Session, token: str, token_type: str) -> Optional[DBUser]:
    """
    Проверить токен. Возвращает пользователя, если токен валиден и не истёк.
    """
    db_token = db.query(EmailToken).filter(
        EmailToken.token == token,
        EmailToken.token_type == token_type,
    ).first()

    if not db_token:
        return None

    # Проверить срок действия
    now = datetime.now(timezone.utc)
    expires = db_token.expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if now > expires:
        # Токен просрочен — удалить
        db.delete(db_token)
        db.commit()
        return None

    user = db.query(DBUser).filter(DBUser.id == db_token.user_id).first()

    # Удалить использованный токен
    db.delete(db_token)
    db.commit()

    return user


def send_email(to: str, subject: str, html_body: str) -> bool:
    """
    Отправить email через SMTP или логировать в консоль.
    """
    if SMTP_ENABLED:
        try:
            msg = MIMEMultipart("alternative")
            msg["Subject"] = subject
            msg["From"] = SMTP_FROM
            msg["To"] = to
            msg.attach(MIMEText(html_body, "html", "utf-8"))

            with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
                server.ehlo()
                server.starttls()
                server.login(SMTP_USER, SMTP_PASSWORD)
                server.sendmail(SMTP_FROM, to, msg.as_string())

            logger.info(f"[EMAIL] Sent to {to}: {subject}")
            return True
        except Exception as e:
            logger.error(f"[EMAIL] Failed to send to {to}: {e}")
            # Fall through to console logging

    # Console fallback — log the email content
    logger.info("=" * 60)
    logger.info(f"[EMAIL SIMULATION] To: {to}")
    logger.info(f"[EMAIL SIMULATION] Subject: {subject}")
    logger.info(f"[EMAIL SIMULATION] Body (HTML stripped):")
    # Extract links from HTML for easy copy
    import re
    links = re.findall(r'href="([^"]+)"', html_body)
    for link in links:
        logger.info(f"  LINK: {link}")
    logger.info("=" * 60)
    return True


def send_confirmation_email(to: str, token: str) -> bool:
    """Отправить письмо подтверждения email."""
    link = f"{FRONTEND_URL}/earth_visualizer.html#confirm={token}"
    html = f"""
    <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px;">
        <h2 style="color:#00bfff;">SPUTNIK</h2>
        <p>Подтвердите ваш email для активации аккаунта:</p>
        <a href="{link}"
           style="display:inline-block;padding:12px 24px;background:#00bfff;color:#fff;
                  text-decoration:none;border-radius:8px;font-weight:bold;margin:16px 0;">
            Подтвердить email
        </a>
        <p style="color:#888;font-size:12px;">Или скопируйте ссылку: {link}</p>
        <p style="color:#888;font-size:12px;">Ссылка действительна {TOKEN_EXPIRY_HOURS} часов.</p>
    </div>
    """
    return send_email(to, "SPUTNIK — Подтверждение email", html)


def send_reset_email(to: str, token: str) -> bool:
    """Отправить письмо сброса пароля."""
    link = f"{FRONTEND_URL}/earth_visualizer.html#reset={token}"
    html = f"""
    <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px;">
        <h2 style="color:#00bfff;">SPUTNIK</h2>
        <p>Вы запросили сброс пароля. Нажмите кнопку ниже:</p>
        <a href="{link}"
           style="display:inline-block;padding:12px 24px;background:#ff5252;color:#fff;
                  text-decoration:none;border-radius:8px;font-weight:bold;margin:16px 0;">
            Сбросить пароль
        </a>
        <p style="color:#888;font-size:12px;">Или скопируйте ссылку: {link}</p>
        <p style="color:#888;font-size:12px;">Ссылка действительна {RESET_EXPIRY_HOURS} час.</p>
        <p style="color:#888;font-size:12px;">Если вы не запрашивали сброс — проигнорируйте это письмо.</p>
    </div>
    """
    return send_email(to, "SPUTNIK — Сброс пароля", html)
