# 曼波语音

Milora 接口：`https://api.milorapart.top/apis/mbAIsc?text=...`。仅将模型选定短句发送给第三方，返回音频须为 `https://media.milorapart.top` 下的 MP3，不接受重定向。

默认每群/私聊间隔15分钟、滚动24小时最多5条、文案最多50字；全局最多20次合成尝试（包括失败），缓存相同文案不重复合成。可在技能设置调整。

合成与发送经过独立限制，失败不记发送次数。缓存及限额位于 `DATA_DIR/manbo-voice/`，不要随技能发布或同步公开仓库。免费额度由服务提供方决定，不保证持续可用。

发送使用 QQ Agent 发送队列与 OneBot `record` 段。QQ Agent 先用 ffmpeg 解码为24kHz单声道PCM，再通过 `silk-wasm` 编成 Tencent SILK，以Base64发送，绕过部分macOS NapCat适配器未实现的MP3到SILK转换。需要安装ffmpeg以及项目依赖；SILK缓存在MP3旁，不修改原音频。合成成功不代表发送成功，以OneBot回执为准。
