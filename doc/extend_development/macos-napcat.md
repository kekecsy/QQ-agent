# macOS With NapCat

Install dependencies with `npm ci`, install QQ and NapCat with the macOS
NapCat installer, then run `npm run start:mac`. The launcher uses macOS
LaunchServices so Electron has its own permission identity. Its default data
directory is `../qq-agent-config/data`; set `QQ_AGENT_DATA_DIR` to override it.

The SnowLuma page starts NapCat on macOS and keeps the existing SnowLuma
workflow on Windows. QQ must be installed at `/Applications/QQ.app`. The
installer's loader and NapCat files must already exist in QQ's container.
Switching QQ's entry requires App Management permission for Electron and may
ask for the current user's administrator password in a local secure dialog.
The helper uses `sudo` only to copy the prepared QQ package entry; it does not
save the password. Building the helper requires Xcode Command Line Tools.
QQ container access can also trigger a macOS permission prompt.

Development Electron auto-login is disabled on macOS because launching its
bundle without the project path opens Electron's welcome page. The tray image
is resized to 18 by 18 points. Windows login behavior is unchanged.

On OneBot connection, up to 50 recent messages from each explicitly allowed
group are imported as read history. They are deduplicated by message ID and
never trigger replies. Availability depends on the gateway's history API;
this is not a complete archive or unlimited backfill.

## Isolated Image Interpretation

The optional `subagent` configuration uses existing provider IDs and their
saved keys. Keys belong in local configuration, never in Git.

```json
{
  "subagent": {
    "enabled": true,
    "mode": "memes",
    "provider": "YOUR_TEXT_PROVIDER_ID",
    "model": "deepseek/deepseek-v4-flash-free",
    "visionProvider": "YOUR_VISION_PROVIDER_ID",
    "visionModel": "DeepSeek-V4-Flash-Vision-Exp"
  }
}
```

Image tools first obtain a bounded visual description, then ask the text
worker to interpret it with up to eight recent messages. Only short text
returns to the main conversation. Neither worker calls tools or sends QQ
messages. Video inputs are not supported in this mode. These requests bypass
the main account pool. Provider IDs and model names must match your local
catalog; the text worker alone cannot see images.

Without `mode: "memes"`, the optional `delegate_analysis` tool performs bounded
read-only text tasks. Disable the subagent to retain the original image-tool
behavior. Run `npm run test:subagent-history` for the focused regression tests.

Sync source through Git, but keep per-machine keys, QQ/NapCat installation,
dependencies and running chat databases outside Git. Prefer only one running
instance for a given QQ bot account.
