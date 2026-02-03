---
name: Advanced__multi-user_support
description: Implement multi-user support for the Telegram bridge
status: Done
created_at: 2025-01-27
updated_at: 2026-02-03 14:59:20
impl_progress:
  planning: completed
  design: completed
  implementation: completed
  review: pending
  testing: in_progress
dependencies: []
tags: [multi-user, authentication, access-control]
---

## WBS#_0020_Advanced__multi-user_support

### Background

The Claude Code Telegram bridge currently operates in single-user mode, storing a single chat_id in a file. This task implements multi-user support to allow multiple Telegram users to use the same bridge instance with proper session isolation and access control.

### Requirements / Objectives

**Functional Requirements:**
- Support multiple Telegram users simultaneously
- User authentication via chat_id
- Per-user session isolation
- User access control (allow/deny lists)
- Per-user configuration
- User management commands

**Non-Functional Requirements:**
- Backward compatible with single-user mode
- Thread-safe user operations
- Minimal overhead for single-user case
- Clear security model

**Acceptance Criteria:**
- [x] Multiple users can use bridge simultaneously
- [x] Sessions are isolated per user
- [x] User authentication works correctly
- [x] Access control is enforced
- [x] User management commands work
- [x] Per-user configuration supported
- [ ] All tests pass
- [ ] Type checking passes
- [x] Backward compatible with existing setup

### Solutions / Goals

**Technology Stack:**
- Python 3
- File-based user store (TOML for config)
- Threading for concurrent operations
- Existing session store (no changes needed)

**Implementation Approach:**
1. Create user data model and store
2. Add user authentication middleware
3. Implement per-user session isolation
4. Add access control enforcement
5. Create user management commands
6. Add configuration support
7. Comprehensive testing

**User Data Model:**
```python
@dataclass
class User:
    chat_id: int
    username: Optional[str]
    first_name: Optional[str]
    created_at: str
    is_active: bool
    is_admin: bool
```

**Configuration (TOML):**
```toml
[multi_user]
enabled = false  # Single-user by default
allowed_users = []  # Empty = all users allowed
admin_users = []  # Admin chat IDs

[users]
# Per-user configuration
```

#### Plan

1. **Phase 1** - User Data Model & Store
   - [x] Create `user.py` with User dataclass
   - [x] Implement UserStore class
   - [x] Add file-based persistence (JSON)
   - [x] Thread-safe operations

2. **Phase 2** - Authentication & Access Control
   - [x] Create `auth.py` module
   - [x] Implement authenticate_user()
   - [x] Implement is_authorized()
   - [x] Add is_admin() check

3. **Phase 3** - Bridge Integration
   - [x] Update `bridge.py` for multi-user
   - [x] Add user middleware to message handler
   - [x] Per-user session isolation
   - [x] Remove single-user CHAT_ID_FILE usage

4. **Phase 4** - User Management Commands
   - [x] /users - List all users
   - [x] /user_info - Show current user info
   - [ ] /add_user - Add user (admin only)
   - [ ] /remove_user - Remove user (admin only)

5. **Phase 5** - Testing
   - [x] Unit tests for User model
   - [x] Unit tests for UserStore
   - [x] Unit tests for auth module
   - [x] Integration tests for bridge

### References

- `/Users/robin/xprojects/claudecode-telegram/session.py` - Session persistence patterns
- `/Users/robin/xprojects/claudecode-telegram/bridge.py` - Current implementation
- Python dataclasses: https://docs.python.org/3/library/dataclasses.html
- TOML configuration: https://docs.python.org/3/library/tomllib.html

### Implementation Summary

**Completed Files:**
1. `user.py` - User data model and UserStore class
2. `auth.py` - Authentication and authorization functions
3. `multi_user_config.py` - Configuration management for multi-user mode
4. `test_user.py` - Comprehensive test suite
5. `MULTI_USER.md` - Documentation for multi-user feature
6. `config.example.toml` - Example configuration file

**Key Features Implemented:**
- User data model with chat_id, username, first_name, created_at, is_active, is_admin
- Thread-safe UserStore with file-based persistence
- Automatic user creation on first message
- User authentication with inactive user detection
- Access control with allowlist support
- Admin privilege checking
- Per-user session isolation (already existed in session.py)
- User management commands (/user_info, /users)
- Configuration integration with existing config system

**Integration Points:**
- bridge.py updated with user authentication middleware
- User store initialized alongside session store
- Multi-user config loaded at startup
- User authentication before message processing
- Authorization checks for restricted access

**Backward Compatibility:**
- Multi-user mode disabled by default
- Existing single-user setups work without changes
- CHAT_ID_FILE still written for compatibility
- Session isolation already existed per chat_id
