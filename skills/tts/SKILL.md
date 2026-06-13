---
name: tts
description: >
  通过小米 MiMo TTS 将文本转为语音。需要朗读文字、生成配音、文本转语音时使用此技能。
  用户说"读一下"、"念这段"、"转成语音"、"TTS"、"配音"、"朗读"时主动使用。
allowed-tools:
  - Bash(ax.ts tts*)
---

# tts

`ax.ts tts` 调用小米 MiMo TTS API 将文本合成语音，输出 24kHz 16-bit mono WAV 文件到 `~/Music/ax-tts/`。

**默认使用 VoiceDesign 模型**（`mimo-v2.5-tts-voicedesign`），通过 `-s` 一句话描述音色即可，效果远好于预置音色。API key 从 vault 的 `mimo_token_plan_token` 读取。

## 重要提示

**默认语速偏慢**，AI 使用时务必在 `-s` 中包含语速提示（如"语速很快"、"语速较快"）才能获得自然语速。

## 命令

```bash
ax.ts tts [options] [text]             # 从命令行文本合成语音
echo "hello" | ax.ts tts [options]     # 从 stdin 合成
ax.ts tts -f <file> [options]          # 从文件读取文本
ax.ts tts -l                           # 列出可用音色
```

## 参数

| 参数 | 说明 |
|------|------|
| `-s, --style <text>` | **音色描述**（默认模型的核心参数）。自然语言描述想要的声音，默认："年轻女性，声音清晰自然，标准普通话，语速很快" |
| `-v, --voice <name>` | 预置音色（仅标准 TTS 模型 `-m mimo-v2.5-tts` 时生效） |
| `-m, --model <name>` | 模型，默认 `mimo-v2.5-tts-voicedesign` |
| `-o, --out <path>` | 输出路径（文件或目录）；`-` 表示不保存仅打印 base64 |
| `--format <fmt>` | 音频格式：`wav`（默认）或 `pcm16` |
| `-f, --file <path>` | 从文件读取文本 |
| `--stdin` | 显式从 stdin 读取 |
| `--play` | 合成后自动播放（WSL 下无窗口后台播放） |
| `--json` | 打印完整 JSON 响应 |
| `-l, --list-voices` | 列出可用音色 |
| `-h, --help` | 帮助 |

## VoiceDesign：AI 使用指南

VoiceDesign 模型通过自然语言描述生成音色。描述越具体越好，涵盖以下维度：

- **性别与年龄**：年轻女性、中年男性、年迈的老先生
- **音色质感**：清脆明亮、低沉磁性、沙哑沧桑、温柔甜美
- **风格人设**：新闻播音员、深夜电台DJ、纪录片旁白、说书先生
- **语速**：**务必包含"语速很快"或"语速较快"**（默认语速偏慢）

### 常用音色描述模板

```bash
# 新闻播音腔
-s "新闻联播女播音员，字正腔圆的央视播音腔，端庄大气，语速很快"

# 温柔女声（默认）
-s "一位年轻女性，声音清晰自然，标准普通话，语速很快"

# 磁性男声
-s "中年男性，嗓音低沉有磁性，像纪录片旁白解说，语速适中偏快"

# 活泼风格
-s "年轻女孩，声音明亮活泼，带一点俏皮，语速很快"

# 说书/故事
-s "年迈的老先生，嗓音沙哑有沧桑感，语速缓慢，像在讲故事"
```

### 导演模式（精细控制）

```bash
-s "角色：百年门阀的大当家，高冷疏离。场景：祠堂阴影里面对来寻她的男人。
指导：极慢语速，冰冷慵懒的低音御姐，每个字都带着上位者的傲慢，句间留白极长。"
```

## 预置音色模型（备选）

需要精确可控的预置音色时，切到 `mimo-v2.5-tts`：

| 模型 | 用途 |
|------|------|
| `mimo-v2.5-tts` | 9 个预置音色（冰糖/茉莉/苏打/白桦/Mia/Chloe/Milo/Dean），`-v` 选择，支持括号标签控制风格 |
| `mimo-v2.5-tts-voiceclone` | 音频复刻音色（传参考音频 base64） |
| `mimo-v2-tts` | V2 旧版，仅 3 个基础音色 |

## 示例

```bash
# 默认 VoiceDesign（年轻女声，语速很快）
ax.ts tts "你好，欢迎使用小米TTS"

# 新闻播音
ax.ts tts -s "新闻联播女播音员，字正腔圆，端庄大气，语速很快" "各位观众晚上好。"

# 磁性男声播报
ax.ts tts -s "中年男性，低沉磁性，像纪录片旁白，语速较快" "在遥远的东方..."

# 英语（描述用英文即可）
ax.ts tts -s "Young American female, clear and professional, fast pace, like a tech podcast host" "Welcome to today's show."

# 从文件读长文本
ax.ts tts -f story.txt -s "说书先生，嗓音沙哑沧桑，语速适中"

# 管道输入 + 播放
echo "hello world" | ax.ts tts --play

# 切回预置音色
ax.ts tts -m mimo-v2.5-tts -v 冰糖 "(开心)今天星期五啦！"
```

## 定价

TTS 全系列限时免费。
