# Kimi Code Provider

`kimi-code` is a native OAuth provider for Kimi Code's OpenAI-compatible
`coding/v1` API.

## Auth

The Admin dashboard uses the same device-code flow as `kimi-cli`:

- `POST https://auth.kimi.com/api/oauth/device_authorization`
- `POST https://auth.kimi.com/api/oauth/token`
- client id: `17e5f671-d194-4dfb-9706-5516cb48c098`

On success, the provider row is stored as:

- `id`: `kimi-code`
- `kind`: `kimi-code`
- `auth_mode`: `oauth`
- `base_url`: `https://api.kimi.com/coding/v1`
- `api_key`: mirror of the current access token

The durable source of truth is `oauth_tokens`, which stores the access token,
refresh token, expiry, scope, device id, OAuth host, token type, and client id.
Runtime calls to `coding/v1` include the Kimi CLI client fingerprint headers
(`User-Agent: KimiCLI/<version>` and `X-Msh-*`) using the persisted device id.

## Models

Live discovery calls:

```text
GET https://api.kimi.com/coding/v1/models
Authorization: Bearer <access_token>
```

The discovery mapper preserves `display_name`, `context_length`,
`supports_reasoning`, `supports_image_in`, and `supports_video_in`. Models with
`thinking` in the id are marked as `always_thinking` in their description.

Fallback seeds:

- `kimi-k2.6`
- `kimi-k2.5`
- `kimi-k2-thinking`
- `kimi-k2-thinking-turbo`
- `kimi-k2-turbo-preview`

## Chat

Coder sessions call:

```text
POST https://api.kimi.com/coding/v1/chat/completions
```

The provider enables streaming, includes usage, maps tool calls to function
tools, forwards images as `image_url`, and preserves prior assistant thinking as
`reasoning_content` for multi-turn continuity. In Node, Kimi's `thinking`
extension is sent as a top-level request field so the OpenAI-compatible SDK
serializes the same wire body as Kimi CLI's Python `extra_body.thinking`.

The provider row can set `extra.kimi_code_thinking_mode`:

- `auto`: follow the session-level thinking toggle.
- `enabled`: always request deep thinking.
- `disabled`: explicitly send `thinking: { type: "disabled" }` to save tokens.

Models whose id contains `thinking` remain `always_thinking` and are forced on
even when the provider preference is `disabled`.
