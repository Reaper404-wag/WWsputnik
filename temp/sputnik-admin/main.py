from fastapi import FastAPI, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from datetime import timedelta
from sqlalchemy.orm import Session
from database import get_db
import auth
# from auth import (
#    create_access_token, get_current_active_user,
#     ACCESS_TOKEN_EXPIRE_MINUTES, get_current_active_admin
# )
from models import User, UserCreate

app = FastAPI(title="Sputnik", version="1.0.0")

@app.get("/")
async def root():
    return {"message": "Welcome"}

@app.post("/register", response_model=User)
async def register_user(user: UserCreate, db: Session = Depends(get_db)):
    """Регистрация."""
    db_user = auth.get_user_by_username(db, username=user.username)
    if db_user:
        raise HTTPException(status_code=400, detail="Username already registered")

    db_user = auth.get_user_by_email(db, email=user.email)
    if db_user:
        raise HTTPException(status_code=400, detail="Email already registered")

    new_user = auth.create_user(db=db, user=user)
    return User(
        username=new_user.username,
        email=new_user.email,
        full_name=new_user.full_name,
        disabled=not new_user.is_active,
        roles=[role.name for role in new_user.roles]
    )

@app.post("/token")
async def login_for_access_token(form_data: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    """Авторизация."""
    user = auth.authenticate_user(db, form_data.username, form_data.password)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )

    access_token_expires = timedelta(minutes=auth.ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = auth.create_access_token(
        data={"sub": user.username}, expires_delta=access_token_expires
    )
    return {"access_token": access_token, "token_type": "bearer"}



@app.get("/users/me", response_model=User)
async def read_users_me(current_user: User = Depends(auth.get_current_active_user)):
    """Получить информацию о пользователе."""
    return current_user

@app.get("/admin/users")
async def admin_get_users(skip: int = 0, limit: int = 100, db: Session = Depends(get_db), current_admin: User = Depends(auth.get_current_active_admin)):
    users = auth.get_all_users(db, skip=skip, limit=limit)
    return users

