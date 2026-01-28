"""
Telegram API models for cc-bridge.

This module contains Pydantic models for Telegram API objects
including updates, messages, callbacks, and inline keyboards.
"""

from pydantic import BaseModel, Field


class User(BaseModel):
    """Telegram user model."""

    id: int
    is_bot: bool = False
    first_name: str
    last_name: str | None = None
    username: str | None = None
    language_code: str | None = None


class Chat(BaseModel):
    """Telegram chat model."""

    id: int
    type: str = Field(..., description="Chat type: private, group, supergroup, channel")
    first_name: str | None = None
    last_name: str | None = None
    username: str | None = None
    title: str | None = None


class Message(BaseModel):
    """Telegram message model."""

    message_id: int
    from_: User | None = Field(None, alias="from")
    date: int
    chat: Chat
    text: str | None = None
    entities: list[dict] | None = None


class CallbackQuery(BaseModel):
    """Telegram callback query model."""

    id: str
    from_: User = Field(..., alias="from")
    message: Message | None = None
    data: str | None = None


class InlineKeyboardButton(BaseModel):
    """Inline keyboard button model."""

    text: str
    callback_data: str | None = None
    url: str | None = None


class InlineKeyboardMarkup(BaseModel):
    """Inline keyboard markup model."""

    inline_keyboard: list[list[InlineKeyboardButton]]


class Update(BaseModel):
    """Telegram update model."""

    update_id: int
    message: Message | None = None
    callback_query: CallbackQuery | None = None


class WebhookRequest(BaseModel):
    """Webhook request model."""

    update: Update
    timestamp: str | None = None
