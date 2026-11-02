# Windows 同步本仓库的技能与插件

同步仓库：<https://github.com/kekecsy/QQ-agent>。技能、插件和它们依赖的核心代码一并更新；不要只复制 `skills/`，肥鱼概率语音、消息恢复、聊天范围设置等依赖新版 `src/` 和设置界面。

## 已有源码目录

先退出 Windows 上的 QQ Agent，在 PowerShell 进入原来的源码目录：

```powershell
git status
git remote -v
```

确认没有未保存的代码改动，且 `origin` 是上面的仓库。若原来指向其他仓库，可以保留它并另加同步源：

```powershell
git remote add kekecsy https://github.com/kekecsy/QQ-agent.git
git fetch kekecsy
git merge --ff-only kekecsy/main
```

若 `origin` 已正确，则使用：

```powershell
git pull --ff-only origin main
```

遇到本地改动或分支分叉时先处理差异，不要用 `reset --hard` 覆盖原有修改。更新后：

```powershell
npm ci
npm start
```

需 Node.js 20 或更新版本；`npm ci` 会安装当前平台的依赖，不能复制 Mac 的 `node_modules/`。

## 首次安装源码

```powershell
git clone https://github.com/kekecsy/QQ-agent.git
cd QQ-agent
npm ci
npm start
```

这是源码同步，已安装的旧版 `.exe` 不会自动更新。可以直接运行上面的源码版本；若需原来的数据，在启动前设置原数据目录的绝对路径，例如：

```powershell
$env:QQ_AGENT_DATA_DIR = 'D:\QQ-Agent-Data'
npm start
```

该路径应是包含 `config.json` 的数据目录。先备份原数据，再切换版本。协议端（NapCat/SnowLuma）及其 Windows 依赖仍由 Windows 本机安装、登录并配置 OneBot 连接。

## 技能和配置的区别

`skills/`、`plugins/`、人设示例及核心代码随 Git 同步。API 密钥、模型供应商配置、技能启用开关、群聊范围、概率、登录 Cookie、聊天记录、记忆和缓存不会随 Git 同步。Windows 上需要在设置页检查并配置这些项目；`personas/` 仅提供人设文本示例，不会覆盖现有会话人设。

本次源码快照以 Mac 上现有技能列表为准，已经移除的 `lol-match`、`steam-deals`、`sukuna-raid` 也会从 Git 管理的源码中移除。

## 肥鱼语音

语音技能和概率插件、分句推理、边缘降噪及拼接间隔压缩均会同步。Windows 需要另装 FFmpeg 并加入 PATH，在新 PowerShell 窗口运行 `ffmpeg -version` 确认可用；QQ SILK 编码所需的 `silk-wasm` 由 `npm ci` 安装。

**模型文件、Python 环境、MLX 服务及本地服务密钥不在本仓库中。仅拉取本仓库不能在 Windows 上完成语音模型部署。** MLX 是此处 Mac 使用的后端；Windows 需另行部署支持以下接口的肥鱼服务（例如原项目的 PyTorch 服务），并确认其返回 PCM16、单声道、24kHz WAV：

- `GET /v1/capabilities`：包含可用的 `tts` 项，`voice=feiyu`，声线为 `cute`/`gentle`。
- `POST /v1/speech`：接受 `{voice: 'feiyu', text, style}`。
- `GET /v1/jobs/<id>`：查询任务，成功时提供音频下载地址；接口细节以 `skills/feiyu-voice/index.js` 为准。
- 地址固定为 `http://127.0.0.1:9880`，使用 Bearer 密钥鉴权。

默认部署目录是源码目录旁的 `feiyu/`，密钥在 `feiyu/.runtime/voice-service/api_key.txt`。若部署在别处，可在启动 Agent 前指定根目录：

```powershell
$env:QQ_AGENT_FEIYU_ROOT = 'D:\feiyu'
npm start
```

此时密钥应在 `D:\feiyu\.runtime\voice-service\api_key.txt`。密钥必须与本机语音服务一致，不要上传 GitHub。Windows 手动启动模型服务后，在肥鱼插件里点“重新检测服务”；可显示连接状态。插件内一键启动仍仅支持 Mac，Windows 不会执行 Mac 的 zsh 启动器。

在技能设置中启用“肥鱼本地语音”和“肥鱼概率语音”，检查群聊范围、声线、调用概率、字数及冷却间隔。服务不可用时，概率语音回退文字。

## 其他有本机依赖的技能

多数技能使用 Node.js 和 OneBot，可直接加载；能否使用还取决于对应 API、服务和登录态。`xhs-surf` 当前随附的服务启动逻辑仅适配 macOS arm64，Windows 需另行适配和部署小红书服务；暂不使用时在技能设置里关闭。QQ 空间能力依赖协议端提供账号登录态，不会复制 Mac 的 Cookie。

本次同步在 Mac 验证模块加载、语音及相关离线测试，没有在 Windows 实机验证模型服务或 QQ 发声。

## 本次验证记录

模块预加载检查和 33 组专项回归通过，涵盖语音服务控制、分句、降噪、间隔压缩、概率语音、图片引用、视觉供应商优先级、历史记录、群聊范围、小红书逻辑及游戏王查询。

完整旧测试集尚未全绿：`selftest.mjs` 的转发缓存提示文本断言、`sticker-collect-test.mjs` 的 file/base64 发送顺序断言、`tools-skill-audit.mjs` 的技能规范审计及 `setup-qq-version.mjs` 的版本检查仍失败。其余单独执行的 26 个默认测试入口通过。此提交用于同步当前开发版本，不代表 Windows 安装包或 Windows 实机验收通过。
