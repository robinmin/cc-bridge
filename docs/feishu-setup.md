# Feishu (飞书/Lark) Setup Guide

This guide explains how to configure cc-bridge to work with Feishu (飞书) or Lark as a secondary channel for interacting with Claude Code.

## Prerequisites

- A Feishu or Lark developer account
- Access to the Feishu Open Platform or Lark Developer Console

## Step 1: Create a Feishu/Lark App

1. Go to [Feishu Open Platform](https://open.feishu.cn/app) (for Feishu) or [Lark Developer Console](https://open.larksuite.com/app) (for Lark)
2. Create a new self-built app
3. Note down your **App ID** and **App Secret**

## Step 2: Configure Bot Permissions

1. In your app settings, enable **Bot** capabilities
2. Add the following permissions:
   - `im:message` - Send and receive messages
   - `im:message:send_as_bot` - Send messages as bot
3. Configure the bot to work in the desired groups/chats

## Step 3: Configure Webhook (Optional)

For webhook mode (recommended):

1. In your app settings, go to **Event Subscriptions**
2. Add your webhook URL:
   - **Channel-specific URL (recommended)**: `https://your-domain.com/webhook/feishu`
   - **Unified URL** (for backward compatibility): `https://your-domain.com/webhook`
3. Subscribe to the `im.message.receive_v1` event
4. Configure encryption (optional but recommended):
   - Generate an **Encrypt Key** and set it as `FEISHU_ENCRYPT_KEY` in your `.env`
   - Note the **Verification Token** and set it as `FEISHU_VERIFICATION_TOKEN` in your `.env`

## Step 4: Configure cc-bridge

Add the following to your `.env` file:

```bash
# Feishu/Lark Bot Configuration
FEISHU_APP_ID=cli_xxxxxxxxxxxxx
FEISHU_APP_SECRET=your_app_secret_here

# Domain: feishu (China) or lark (International)
# Default: feishu
FEISHU_DOMAIN=feishu

# Optional: Webhook verification
# FEISHU_ENCRYPT_KEY=your_encrypt_key_here
# FEISHU_VERIFICATION_TOKEN=your_verification_token_here
```

## Step 5: Add Bot to Chat

1. In Feishu/Lark, add your bot to the desired group chat
2. Use the `/help` command to see available cc-bridge commands
3. Start interacting with Claude Code through Feishu!

## Features

The Feishu channel supports:

- **Text messages**: Send commands and receive responses
- **Bot menu commands**: Use `/start`, `/help`, `/status`, etc.
- **Direct messages**: Works in both direct and group chats
- **Multi-domain support**: Works with both Feishu (China) and Lark (International)

## Limitations

- **Typing indicators**: Feishu doesn't support native typing indicators
- **Bot menu setup**: Bot commands must be configured in the Feishu Open Platform console
- **Rich content**: Currently only text messages are supported (future enhancement)

## Troubleshooting

### Webhook not receiving events

- Verify the webhook URL is correctly configured in Feishu Open Platform
- Check that the event subscription for `im.message.receive_v1` is active
- Ensure your server is publicly accessible (use Cloudflare Tunnel if needed)

### Authentication errors

- Verify `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are correct
- Check that the app has the required permissions
- Ensure the domain setting (`FEISHU_DOMAIN`) matches your region

### Bot not responding

- Check the gateway logs for errors
- Verify the bot has been added to the chat
- Ensure the webhook is receiving events (check Feishu event logs)

## Additional Resources

- [Feishu Bot Development Documentation](https://open.feishu.cn/document/ukTMukTMukTM/uUTNz4SN1MjL1UzM)
- [Lark Bot Development Documentation](https://open.larksuite.com/document/ukTMukTMukTM/uUTNz4SN1MjL1UzM)
- [OpenClaw Feishu Extension](vendors/openclaw/extensions/feishu/) - Reference implementation

## Security Notes

- Keep your `FEISHU_APP_SECRET` secure and never commit it to version control
- Use webhook encryption (`FEISHU_ENCRYPT_KEY`) for production deployments
- Consider using allowlists to restrict which users/groups can interact with the bot
