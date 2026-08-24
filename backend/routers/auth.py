"""
routers/auth.py — Авторизация и регистрация пользователей.

Эндпоинты:
  POST /auth/register  — Регистрация нового пользователя (+ отправка подтверждения)
  POST /auth/login     — Вход, получение JWT access token
  GET  /auth/me        — Информация о текущем пользователе
  POST /auth/confirm-email — Подтверждение email по токену
  POST /auth/forgot-password — Запрос сброса пароля
  POST /auth/reset-password  — Сброс пароля по токену
  GET  /auth/users     — [ADMIN] Список всех пользователей
  PUT  /auth/users/{user_id}/role  — [ADMIN] Назначить/снять роль
  PUT  /auth/users/{user_id}/toggle — [ADMIN] Активировать/деактивировать
"""

from datetime import timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.models.user import User as DBUser
from backend.services.auth_service import (
    create_user,
    authenticate_user,
    create_access_token,
    get_current_active_user,
    get_current_admin,
    get_current_admin_or_leader,
    get_all_users,
    get_user_by_username,
    get_user_by_email,
    get_user_by_id,
    assign_role,
    remove_role,
    hash_password,
)
from backend.services.email_service import (
    create_email_token,
    verify_token,
    send_confirmation_email,
    send_reset_email,
)
from backend.config import get_settings

settings = get_settings()
router = APIRouter(prefix="/auth", tags=["Auth"])


# ========== Pydantic Schemas ==========

class UserCreate(BaseModel):
    username: str
    email: str
    full_name: str
    password: str


class UserResponse(BaseModel):
    id: int
    username: str
    email: str
    full_name: str
    is_active: bool
    email_confirmed: bool = False
    roles: list[str]

    class Config:
        from_attributes = True


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class RoleAction(BaseModel):
    role: str
    action: str = "assign"  # "assign" or "remove"


class ForgotPasswordRequest(BaseModel):
    email: str


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str


class ConfirmEmailRequest(BaseModel):
    token: str


# ========== Endpoints ==========

@router.post("/register", response_model=UserResponse, status_code=201)
async def register(user_data: UserCreate, db: Session = Depends(get_db)):
    """Регистрация нового пользователя."""
    # Проверка уникальности username
    if get_user_by_username(db, user_data.username):
        raise HTTPException(status_code=400, detail="Логин уже занят")

    # Проверка уникальности email
    if get_user_by_email(db, user_data.email):
        raise HTTPException(status_code=400, detail="Email уже зарегистрирован")

    # Создание пользователя
    db_user = create_user(
        db=db,
        username=user_data.username,
        email=user_data.email,
        full_name=user_data.full_name,
        password=user_data.password,
    )

    # Отправить email подтверждения
    token = create_email_token(db, db_user, "confirm")
    send_confirmation_email(db_user.email, token)

    return UserResponse(
        id=db_user.id,
        username=db_user.username,
        email=db_user.email,
        full_name=db_user.full_name,
        is_active=db_user.is_active,
        email_confirmed=db_user.email_confirmed,
        roles=[r.name for r in db_user.roles],
    )


@router.post("/login", response_model=TokenResponse)
async def login(
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: Session = Depends(get_db),
):
    """Авторизация. Возвращает JWT access token."""
    user = authenticate_user(db, form_data.username, form_data.password)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Неверный логин или пароль",
            headers={"WWW-Authenticate": "Bearer"},
        )

    access_token = create_access_token(
        data={"sub": user.username},
        expires_delta=timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES),
    )
    return TokenResponse(access_token=access_token)


@router.get("/me", response_model=UserResponse)
async def get_me(current_user: DBUser = Depends(get_current_active_user)):
    """Получить информацию о текущем пользователе."""
    return UserResponse(
        id=current_user.id,
        username=current_user.username,
        email=current_user.email,
        full_name=current_user.full_name,
        is_active=current_user.is_active,
        email_confirmed=current_user.email_confirmed,
        roles=[r.name for r in current_user.roles],
    )


# ========== Email Confirmation & Password Reset ==========

@router.post("/confirm-email")
async def confirm_email(data: ConfirmEmailRequest, db: Session = Depends(get_db)):
    """Подтверждение email по токену из письма."""
    user = verify_token(db, data.token, "confirm")
    if not user:
        raise HTTPException(status_code=400, detail="Недействительный или просроченный токен")

    user.email_confirmed = True
    db.commit()
    return {"status": "ok", "message": "Email подтверждён"}


@router.post("/forgot-password")
async def forgot_password(data: ForgotPasswordRequest, db: Session = Depends(get_db)):
    """Запрос сброса пароля — отправляет ссылку на email."""
    user = get_user_by_email(db, data.email)
    if not user:
        # Не раскрываем, существует ли email (безопасность)
        return {"status": "ok", "message": "Если email зарегистрирован, ссылка отправлена"}

    token = create_email_token(db, user, "reset")
    send_reset_email(user.email, token)
    return {"status": "ok", "message": "Если email зарегистрирован, ссылка отправлена"}


@router.post("/reset-password")
async def reset_password(data: ResetPasswordRequest, db: Session = Depends(get_db)):
    """Сброс пароля по токену из письма."""
    user = verify_token(db, data.token, "reset")
    if not user:
        raise HTTPException(status_code=400, detail="Недействительный или просроченный токен")

    if len(data.new_password) < 4:
        raise HTTPException(status_code=400, detail="Пароль слишком короткий (мин. 4 символа)")

    user.hashed_password = hash_password(data.new_password)
    db.commit()
    return {"status": "ok", "message": "Пароль успешно изменён"}


@router.post("/resend-confirmation")
async def resend_confirmation(
    db: Session = Depends(get_db),
    current_user: DBUser = Depends(get_current_active_user),
):
    """Повторная отправка подтверждения email."""
    if current_user.email_confirmed:
        return {"status": "ok", "message": "Email уже подтверждён"}

    token = create_email_token(db, current_user, "confirm")
    send_confirmation_email(current_user.email, token)
    return {"status": "ok", "message": "Письмо отправлено"}


# ========== Admin Endpoints ==========

@router.get("/users", response_model=list[UserResponse])
async def admin_list_users(
    skip: int = 0,
    limit: int = 100,
    db: Session = Depends(get_db),
    admin: DBUser = Depends(get_current_admin_or_leader),
):
    """[ADMIN] Получить список всех пользователей."""
    users = get_all_users(db, skip=skip, limit=limit)
    return [
        UserResponse(
            id=u.id,
            username=u.username,
            email=u.email,
            full_name=u.full_name,
            is_active=u.is_active,
            email_confirmed=u.email_confirmed,
            roles=[r.name for r in u.roles],
        )
        for u in users
    ]


@router.put("/users/{user_id}/role", response_model=UserResponse)
async def admin_change_role(
    user_id: int,
    role_action: RoleAction,
    db: Session = Depends(get_db),
    admin: DBUser = Depends(get_current_admin_or_leader),
):
    """[ADMIN/LEADER] Назначить или снять роль пользователю."""
    user = get_user_by_id(db, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="Пользователь не найден")

    # Leader can only manage 'leader' role, not 'admin'
    if not admin.has_role("admin") and role_action.role == "admin":
        raise HTTPException(status_code=403, detail="Только админ может назначать роль admin")

    if role_action.action == "assign":
        user = assign_role(db, user, role_action.role)
    elif role_action.action == "remove":
        user = remove_role(db, user, role_action.role)
    else:
        raise HTTPException(status_code=400, detail="action должен быть 'assign' или 'remove'")

    return UserResponse(
        id=user.id,
        username=user.username,
        email=user.email,
        full_name=user.full_name,
        is_active=user.is_active,
        roles=[r.name for r in user.roles],
    )


@router.put("/users/{user_id}/toggle", response_model=UserResponse)
async def admin_toggle_user(
    user_id: int,
    db: Session = Depends(get_db),
    admin: DBUser = Depends(get_current_admin),
):
    """[ADMIN] Активировать/деактивировать пользователя."""
    user = get_user_by_id(db, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="Пользователь не найден")

    user.is_active = not user.is_active
    db.commit()
    db.refresh(user)

    return UserResponse(
        id=user.id,
        username=user.username,
        email=user.email,
        full_name=user.full_name,
        is_active=user.is_active,
        roles=[r.name for r in user.roles],
    )
