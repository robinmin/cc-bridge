"""
Telegram API models for cc-bridge.

This module contains Pydantic models for Telegram API objects
including updates, messages, callbacks, and inline keyboards.
"""

from pydantic import BaseModel, Field
from typing import Optional, List


class User(BaseModel):
    """Telegram user model."""

    id: int
    is_bot: bool = False
    first_name: str
    last_name: Optional[str] = None
    username: Optional[str] = None
    language_code: Optional[str] = None


class Chat(BaseModel):
    """Telegram chat model."""

    id: int
    type: str = Field(..., description="Chat type: private, group, supergroup, channel")
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    username: Optional[str] = None
    title: Optional[str] = None


class Message(BaseModel):
    """Telegram message model."""

    message_id: int
    from_: Optional[User] = Field(None, alias="from")
    date: int
    chat: Chat
    text: Optional[str] = None
    entities: Optional[List[dict]] = None


class CallbackQuery(BaseModel):
    """Telegram callback query model."""

    id: str
    from_: User = Field(..., alias="from")
    message: Optional[Message] = None
    data: Optional[str] = None


class InlineKeyboardButton(BaseModel):
    """Inline keyboard button model."""

    text: str
    callback_data: Optional[str] = None
    url: Optional[str] = None


class InlineKeyboardMarkup(BaseModel):
    """Inline keyboard markup model."""

    inline_keyboard: List[List[InlineKeyboardButton]]


class Update(BaseModel):
    """Telegram update model."""

    update_id: int
    message: Optional[Message] = None
    callback_query: Optional[CallbackQuery] = None


class WebhookRequest(BaseModel):
    """Webhook request model."""

    update: Update
    timestamp: Optional[str] = None
