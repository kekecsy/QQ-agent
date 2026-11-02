# Per-Chat Extension Scope

Every installed Skill and plugin uses the same `config.skills[id].chatScope`:

```json
{ "mode": "only", "chats": ["group:377057863", "private:2714745270"] }
```

- `all`: available in every permitted chat (legacy default).
- `only`: available only in selected chats; an empty list disables all chat use.
- `except`: available everywhere except selected chats.
- The global extension switch remains authoritative. Scope never grants access
  outside the application's allowlist, bypasses a denylist, or enables dependencies.

Use the extension's Settings button to change scope. It applies to both Skills and
plugins, including those without manifest settings. Persona settings remain under
the existing per-chat Persona editor; these are independent controls.

The manager filters prompt sections, capabilities, and hooks by `context.chatKey`.
Tool execution rechecks live scope, even for tools advertised before a setting
change. Async extension contexts propagate to nested capability calls and the
shared sender, which checks the destination again before sending.

Plugins with native message interceptors or their own timers must call
`api.isEnabledForChat(chatKey)` before inspecting a chat and again before delayed
delivery. Cross-chat plugins must check both source and destination. The installed
repeat-echo, ygo-quick-card, and forward-relay plugins implement these checks.

Account-level operations without a destination chat (model pools, cache maintenance,
Xiaohongshu browsing, QQ favorite collection, QQ Space publishing) still follow
global extension settings. A chat scope does not create separate QQ identities or
separate account-level schedules. Use the global switch to stop those services.

Extensions are trusted local JavaScript, not sandboxed programs. Third-party code
that directly accesses files, patches prototypes, or calls external APIs without
using the extension API must adopt these checks; scope is not an OS sandbox.
