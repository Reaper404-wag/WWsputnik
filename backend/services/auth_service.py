"""
services/auth_service.py — Сервис авторизации.

JWT-токены, хэширование паролей, CRUD пользователей и ролей.
"""

from datetime import datetime, timedelta, timezone
from typing import Optional

from passlib.context import CryptContext
from jose import JWTError, jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from backend.config import get_settings
from backend.database import get_db
from backend.models.user import User as DBUser
from backend.models.role import Role as DBRole

settings = get_settings()

# --- Password hashing ---
pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")

# --- OAuth2 scheme ---
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login", auto_error=False)


# ========== Password utils ==========

def hash_password(password: str) -> str:
    """Хэшировать пароль."""
    return pwd_context.hash(password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Верифицировать пароль."""
    return pwd_context.verify(plain_password, hashed_password)


# ========== JWT utils ==========

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """Создать JWT access token."""
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (
        expires_delta or timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def decode_token(token: str) -> Optional[str]:
    """Декодировать JWT, вернуть username или None."""
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        return payload.get("sub")
    except JWTError:
        return None


# ========== User CRUD ==========

def get_user_by_username(db: Session, username: str) -> Optional[DBUser]:
    """Найти пользователя по логину."""
    return db.query(DBUser).filter(DBUser.username == username).first()


def get_user_by_email(db: Session, email: str) -> Optional[DBUser]:
    """Найти пользователя по email."""
    return db.query(DBUser).filter(DBUser.email == email).first()


def get_user_by_id(db: Session, user_id: int) -> Optional[DBUser]:
    """Найти пользователя по ID."""
    return db.query(DBUser).filter(DBUser.id == user_id).first()


def get_all_users(db: Session, skip: int = 0, limit: int = 100) -> list[DBUser]:
    """Получить всех пользователей."""
    return db.query(DBUser).offset(skip).limit(limit).all()


def create_user(db: Session, username: str, email: str, full_name: str, password: str) -> DBUser:
    """Создать нового пользователя с ролью 'user'."""
    db_user = DBUser(
        username=username,
        email=email,
        full_name=full_name,
        hashed_password=hash_password(password),
    )

    # Назначить роль user
    user_role = get_or_create_role(db, "user", "Обычный пользователь")
    db_user.roles.append(user_role)

    db.add(db_user)
    db.commit()
    db.refresh(db_user)
    return db_user


def authenticate_user(db: Session, username: str, password: str) -> Optional[DBUser]:
    """Проверить логин и пароль, вернуть пользователя или None."""
    user = get_user_by_username(db, username)
    if not user:
        return None
    if not verify_password(password, user.hashed_password):
        return None
    return user


# ========== Role CRUD ==========

def get_or_create_role(db: Session, name: str, description: str = "") -> DBRole:
    """Получить роль по имени или создать, если не существует."""
    role = db.query(DBRole).filter(DBRole.name == name).first()
    if not role:
        role = DBRole(name=name, description=description)
        db.add(role)
        db.commit()
        db.refresh(role)
    return role


def assign_role(db: Session, user: DBUser, role_name: str) -> DBUser:
    """Назначить роль пользователю."""
    role = get_or_create_role(db, role_name)
    if role not in user.roles:
        user.roles.append(role)
        db.commit()
        db.refresh(user)
    return user


def remove_role(db: Session, user: DBUser, role_name: str) -> DBUser:
    """Снять роль у пользователя."""
    role = db.query(DBRole).filter(DBRole.name == role_name).first()
    if role and role in user.roles:
        user.roles.remove(role)
        db.commit()
        db.refresh(user)
    return user


# ========== FastAPI Dependencies ==========

async def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> DBUser:
    """Получить текущего пользователя из JWT токена."""
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Не удалось проверить учётные данные",
        headers={"WWW-Authenticate": "Bearer"},
    )

    if token is None:
        raise credentials_exception

    username = decode_token(token)
    if username is None:
        raise credentials_exception

    user = get_user_by_username(db, username)
    if user is None:
        raise credentials_exception

    return user


async def get_current_active_user(
    current_user: DBUser = Depends(get_current_user),
) -> DBUser:
    """Проверить, что пользователь активен."""
    if not current_user.is_active:
        raise HTTPException(status_code=400, detail="Аккаунт деактивирован")
    return current_user


async def get_current_admin(
    current_user: DBUser = Depends(get_current_active_user),
) -> DBUser:
    """Проверить, что пользователь — администратор."""
    if not current_user.has_role("admin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Недостаточно прав. Требуется роль admin.",
        )
    return current_user


async def get_current_admin_or_leader(
    current_user: DBUser = Depends(get_current_active_user),
) -> DBUser:
    """Проверить, что пользователь — администратор или руководитель."""
    if not (current_user.has_role("admin") or current_user.has_role("leader")):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Недостаточно прав. Требуется роль admin или leader.",
        )
    return current_user
