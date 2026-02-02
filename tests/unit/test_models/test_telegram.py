"""
Tests for Telegram API models.
"""

from cc_bridge.models.telegram import (
    CallbackQuery,
    Chat,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
    Update,
    User,
    WebhookRequest,
)


class TestUser:
    """Tests for User model."""

    def test_create_user_with_required_fields(self):
        """Test creating user with required fields."""
        user = User(id=123, first_name="John")
        assert user.id == 123
        assert user.first_name == "John"
        assert user.is_bot is False  # Default value

    def test_user_default_is_bot(self):
        """Test that is_bot defaults to False."""
        user = User(id=123, first_name="John")
        assert user.is_bot is False

    def test_user_with_all_fields(self):
        """Test creating user with all fields."""
        user = User(
            id=123,
            is_bot=True,
            first_name="John",
            last_name="Doe",
            username="johndoe",
            language_code="en",
        )
        assert user.id == 123
        assert user.is_bot is True
        assert user.first_name == "John"
        assert user.last_name == "Doe"
        assert user.username == "johndoe"
        assert user.language_code == "en"

    def test_user_optional_fields_are_none(self):
        """Test that optional fields default to None."""
        user = User(id=123, first_name="John")
        assert user.last_name is None
        assert user.username is None
        assert user.language_code is None


class TestChat:
    """Tests for Chat model."""

    def test_create_chat_with_required_fields(self):
        """Test creating chat with required fields."""
        chat = Chat(id=456, type="private")
        assert chat.id == 456
        assert chat.type == "private"

    def test_private_chat(self):
        """Test private chat type."""
        chat = Chat(id=456, type="private", first_name="John", username="johndoe")
        assert chat.type == "private"
        assert chat.first_name == "John"
        assert chat.username == "johndoe"
        assert chat.title is None

    def test_group_chat(self):
        """Test group chat type."""
        chat = Chat(id=456, type="group", title="Test Group")
        assert chat.type == "group"
        assert chat.title == "Test Group"
        assert chat.first_name is None

    def test_supergroup_chat(self):
        """Test supergroup chat type."""
        chat = Chat(id=456, type="supergroup", title="Test SuperGroup")
        assert chat.type == "supergroup"
        assert chat.title == "Test SuperGroup"

    def test_channel_chat(self):
        """Test channel chat type."""
        chat = Chat(id=456, type="channel", title="Test Channel")
        assert chat.type == "channel"
        assert chat.title == "Test Channel"

    def test_chat_all_optional_fields(self):
        """Test chat with all optional fields."""
        chat = Chat(
            id=456,
            type="private",
            first_name="John",
            last_name="Doe",
            username="johndoe",
            title=None,  # Private chats don't have titles
        )
        assert chat.first_name == "John"
        assert chat.last_name == "Doe"
        assert chat.username == "johndoe"


class TestMessage:
    """Tests for Message model."""

    def test_create_message_with_required_fields(self):
        """Test creating message with required fields."""
        chat = Chat(id=456, type="private")
        message = Message(message_id=1, date=1234567890, chat=chat)
        assert message.message_id == 1
        assert message.date == 1234567890
        assert message.chat.id == 456

    def test_message_with_user(self):
        """Test message with from user."""
        user = User(id=123, first_name="John")
        chat = Chat(id=456, type="private")
        # Use model_validate with dict to handle the 'from' alias properly
        message = Message.model_validate(
            {
                "message_id": 1,
                "date": 1234567890,
                "chat": chat.model_dump(),
                "from": user.model_dump(),
            }
        )
        assert message.from_ is not None
        assert message.from_.id == 123
        assert message.from_.first_name == "John"

    def test_message_with_text(self):
        """Test message with text content."""
        chat = Chat(id=456, type="private")
        message = Message(message_id=1, date=1234567890, chat=chat, text="Hello, World!")
        assert message.text == "Hello, World!"

    def test_message_with_entities(self):
        """Test message with entities."""
        chat = Chat(id=456, type="private")
        entities = [{"type": "bold", "offset": 0, "length": 5}]
        message = Message(message_id=1, date=1234567890, chat=chat, text="Hello", entities=entities)
        assert message.entities == entities

    def test_message_without_text(self):
        """Test message without text (e.g., media)."""
        chat = Chat(id=456, type="private")
        message = Message(message_id=1, date=1234567890, chat=chat)
        assert message.text is None


class TestCallbackQuery:
    """Tests for CallbackQuery model."""

    def test_create_callback_query_with_required_fields(self):
        """Test creating callback query with required fields."""
        user = User(id=123, first_name="John")
        # Use model_validate with dict to handle the 'from' alias properly
        callback = CallbackQuery.model_validate({"id": "cb123", "from": user.model_dump()})
        assert callback.id == "cb123"
        assert callback.from_.id == 123

    def test_callback_query_with_message(self):
        """Test callback query with message."""
        user = User(id=123, first_name="John")
        chat = Chat(id=456, type="private")
        message = Message(message_id=1, date=1234567890, chat=chat)
        callback = CallbackQuery.model_validate(
            {
                "id": "cb123",
                "from": user.model_dump(),
                "message": message.model_dump(),
            }
        )
        assert callback.message is not None
        assert callback.message.message_id == 1

    def test_callback_query_with_data(self):
        """Test callback query with callback data."""
        user = User(id=123, first_name="John")
        callback = CallbackQuery.model_validate(
            {"id": "cb123", "from": user.model_dump(), "data": "button_click"}
        )
        assert callback.data == "button_click"

    def test_callback_query_optional_fields(self):
        """Test callback query without optional fields."""
        user = User(id=123, first_name="John")
        callback = CallbackQuery.model_validate({"id": "cb123", "from": user.model_dump()})
        assert callback.message is None
        assert callback.data is None


class TestInlineKeyboardButton:
    """Tests for InlineKeyboardButton model."""

    def test_create_button_with_text_only(self):
        """Test creating button with just text."""
        button = InlineKeyboardButton(text="Click Me")
        assert button.text == "Click Me"
        assert button.callback_data is None
        assert button.url is None

    def test_button_with_callback_data(self):
        """Test button with callback data."""
        button = InlineKeyboardButton(text="Click Me", callback_data="cb_123")
        assert button.text == "Click Me"
        assert button.callback_data == "cb_123"
        assert button.url is None

    def test_button_with_url(self):
        """Test button with URL."""
        button = InlineKeyboardButton(text="Open URL", url="https://example.com")
        assert button.text == "Open URL"
        assert button.url == "https://example.com"
        assert button.callback_data is None

    def test_button_with_both_callback_and_url(self):
        """Test button with both callback data and URL."""
        # Note: In real Telegram API, only one should be set
        # But the model allows both
        button = InlineKeyboardButton(
            text="Button", callback_data="cb_123", url="https://example.com"
        )
        assert button.callback_data == "cb_123"
        assert button.url == "https://example.com"


class TestInlineKeyboardMarkup:
    """Tests for InlineKeyboardMarkup model."""

    def test_create_keyboard_with_one_row(self):
        """Test creating keyboard with one row of buttons."""
        button = InlineKeyboardButton(text="Button 1")
        keyboard = InlineKeyboardMarkup(inline_keyboard=[[button]])
        assert len(keyboard.inline_keyboard) == 1
        assert len(keyboard.inline_keyboard[0]) == 1

    def test_create_keyboard_with_multiple_rows(self):
        """Test creating keyboard with multiple rows."""
        row1 = [InlineKeyboardButton(text="Button 1"), InlineKeyboardButton(text="Button 2")]
        row2 = [InlineKeyboardButton(text="Button 3")]
        keyboard = InlineKeyboardMarkup(inline_keyboard=[row1, row2])
        assert len(keyboard.inline_keyboard) == 2
        assert len(keyboard.inline_keyboard[0]) == 2
        assert len(keyboard.inline_keyboard[1]) == 1

    def test_create_keyboard_with_multiple_columns(self):
        """Test creating keyboard with multiple columns in one row."""
        row = [
            InlineKeyboardButton(text="Button 1"),
            InlineKeyboardButton(text="Button 2"),
            InlineKeyboardButton(text="Button 3"),
        ]
        keyboard = InlineKeyboardMarkup(inline_keyboard=[row])
        assert len(keyboard.inline_keyboard[0]) == 3

    def test_empty_keyboard(self):
        """Test creating empty keyboard."""
        keyboard = InlineKeyboardMarkup(inline_keyboard=[])
        assert keyboard.inline_keyboard == []


class TestUpdate:
    """Tests for Update model."""

    def test_create_update_with_required_fields(self):
        """Test creating update with required fields."""
        update = Update(update_id=123)
        assert update.update_id == 123
        assert update.message is None
        assert update.callback_query is None

    def test_update_with_message(self):
        """Test update with message."""
        chat = Chat(id=456, type="private")
        message = Message(message_id=1, date=1234567890, chat=chat, text="Hello")
        update = Update(update_id=123, message=message)
        assert update.message is not None
        assert update.message.text == "Hello"
        assert update.callback_query is None

    def test_update_with_callback_query(self):
        """Test update with callback query."""
        user = User(id=123, first_name="John")
        callback = CallbackQuery.model_validate(
            {"id": "cb123", "from": user.model_dump(), "data": "click"}
        )
        update = Update(update_id=123, callback_query=callback)
        assert update.callback_query is not None
        assert update.callback_query.data == "click"
        assert update.message is None

    def test_update_with_both_message_and_callback(self):
        """Test update with both message and callback (unusual but possible)."""
        chat = Chat(id=456, type="private")
        message = Message(message_id=1, date=1234567890, chat=chat)
        user = User(id=123, first_name="John")
        callback = CallbackQuery.model_validate(
            {
                "id": "cb123",
                "from": user.model_dump(),
                "message": message.model_dump(),
                "data": "click",
            }
        )
        update = Update(update_id=123, message=message, callback_query=callback)
        assert update.message is not None
        assert update.callback_query is not None


class TestWebhookRequest:
    """Tests for WebhookRequest model."""

    def test_create_webhook_request_with_update(self):
        """Test creating webhook request with update."""
        update = Update(update_id=123)
        request = WebhookRequest(update=update)
        assert request.update.update_id == 123
        assert request.timestamp is None

    def test_webhook_request_with_timestamp(self):
        """Test webhook request with timestamp."""
        update = Update(update_id=123)
        request = WebhookRequest(update=update, timestamp="2024-01-01T00:00:00Z")
        assert request.timestamp == "2024-01-01T00:00:00Z"

    def test_webhook_request_with_nested_message(self):
        """Test webhook request with nested message."""
        chat = Chat(id=456, type="private")
        message = Message(message_id=1, date=1234567890, chat=chat, text="Hello")
        update = Update(update_id=123, message=message)
        request = WebhookRequest(update=update)
        assert request.update.message is not None
        assert request.update.message.text == "Hello"

    def test_webhook_request_serialization(self):
        """Test that webhook request can be serialized to dict."""
        chat = Chat(id=456, type="private")
        message = Message(message_id=1, date=1234567890, chat=chat, text="Hello")
        update = Update(update_id=123, message=message)
        request = WebhookRequest(update=update, timestamp="2024-01-01T00:00:00Z")

        # Test model_dump
        data = request.model_dump()
        assert "update" in data
        assert data["timestamp"] == "2024-01-01T00:00:00Z"

    def test_webhook_request_json_serialization(self):
        """Test that webhook request can be serialized to JSON."""
        chat = Chat(id=456, type="private")
        message = Message(message_id=1, date=1234567890, chat=chat, text="Hello")
        update = Update(update_id=123, message=message)
        request = WebhookRequest(update=update)

        # Test model_dump_json
        json_str = request.model_dump_json()
        assert "update" in json_str
        assert "123" in json_str  # update_id
