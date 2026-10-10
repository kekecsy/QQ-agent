# DeepSeek 娘本地动图

在 QQ Agent 技能设置中填写包含 `gifs` 的表情包目录，或直接选择 GIF 目录。默认自动查找项目旁的 `deepseek-chan-emotes-*`。

模型先按情绪调用 `list_emotes` 获取真实候选，再决定是否调用 `send_emote`。发送原始 GIF，不上传给看图模型、不转码，不要求 API Key。动画能否播放取决于 QQ 客户端。

默认每会话间隔180秒、每小时6张、滚动24小时30张，并避免重复最近8张。成功发送后才记账；并发重复请求被拦截。设置为0的上限表示禁止发送。

GIF 位于外部数据目录，不打包入技能或自动提交 GitHub。Windows 上在设置中填写当地目录即可。

来源署名参见用户下载包的 README：BrickAZ/deepseek-chan-emotes，角色来源为 Steam 创意工坊「蓝色大肥鱼」，作者飞天豆之助，使用 EmoteLab 导出。分享素材前请遵守原作者的使用和转载要求。
