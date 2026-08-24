"""
routers/chat.py — Чат для команды мониторинга.

Endpoints:
  GET  /chat/messages       — Получить сообщения (с пагинацией)
  POST /chat/messages       — Отправить сообщение
  DELETE /chat/messages/{id} — Удалить своё сообщение (или admin/leader)
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session
from typing import Optional
from datetime import datetime

from backend.database import get_db
from backend.models.user import User as DBUser
from backend.models.chat_message import ChatMessage
from backend.services.auth_service import get_current_active_user

router = APIRouter(prefix="/chat", tags=["Chat"])


class MessageCreate(BaseModel):
    text: str
    mentioned_norad_id: Optional[int] = None


class MessageResponse(BaseModel):
    id: int
    user_id: int
    username: str
    full_name: str
    user_roles: list[str]
    text: str
    mentioned_norad_id: Optional[int] = None
    created_at: str

    class Config:
        from_attributes = True


@router.get("/messages", response_model=list[MessageResponse])
async def get_messages(
    limit: int = Query(50, ge=1, le=200),
    before_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    current_user: DBUser = Depends(get_current_active_user),
):
    """Получить сообщения чата (последние N)."""
    q = db.query(ChatMessage)
    if before_id:
        q = q.filter(ChatMessage.id < before_id)
    messages = q.order_by(ChatMessage.id.desc()).limit(limit).all()
    messages.reverse()  # chronological order

    return [
        MessageResponse(
            id=m.id,
            user_id=m.user_id,
            username=m.user.username,
            full_name=m.user.full_name or m.user.username,
            user_roles=[r.name for r in m.user.roles],
            text=m.text,
            mentioned_norad_id=m.mentioned_norad_id,
            created_at=m.created_at.isoformat() if m.created_at else "",
        )
        for m in messages
    ]


@router.post("/messages", response_model=MessageResponse, status_code=201)
async def send_message(
    data: MessageCreate,
    db: Session = Depends(get_db),
    current_user: DBUser = Depends(get_current_active_user),
):
    """Отправить сообщение в чат."""
    if not data.text.strip():
        raise HTTPException(status_code=400, detail="Сообщение не может быть пустым")

    if len(data.text) > 2000:
        raise HTTPException(status_code=400, detail="Сообщение слишком длинное (макс. 2000 символов)")

    msg = ChatMessage(
        user_id=current_user.id,
        text=data.text.strip(),
        mentioned_norad_id=data.mentioned_norad_id,
    )
    db.add(msg)
    db.commit()
    db.refresh(msg)

    return MessageResponse(
        id=msg.id,
        user_id=msg.user_id,
        username=current_user.username,
        full_name=current_user.full_name or current_user.username,
        user_roles=[r.name for r in current_user.roles],
        text=msg.text,
        mentioned_norad_id=msg.mentioned_norad_id,
        created_at=msg.created_at.isoformat() if msg.created_at else "",
    )


@router.delete("/messages/{message_id}")
async def delete_message(
    message_id: int,
    db: Session = Depends(get_db),
    current_user: DBUser = Depends(get_current_active_user),
):
    """Удалить сообщение (своё или admin/leader может удалить любое)."""
    msg = db.query(ChatMessage).filter(ChatMessage.id == message_id).first()
    if not msg:
        raise HTTPException(status_code=404, detail="Сообщение не найдено")

    is_owner = msg.user_id == current_user.id
    is_privileged = current_user.has_role("admin") or current_user.has_role("leader")

    if not is_owner and not is_privileged:
        raise HTTPException(status_code=403, detail="Нет прав на удаление")

    db.delete(msg)
    db.commit()
    return {"status": "ok"}
