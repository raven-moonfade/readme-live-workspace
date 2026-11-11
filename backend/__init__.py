# -*- coding: utf-8 -*-
"""幕台后端包。

对外唯一入口：``backend.DanmakuTTSService``（接口契约见 core.py）。
主控 app.py 只需：

    from backend import DanmakuTTSService
    service = DanmakuTTSService(base_dir)   # base_dir 传项目根目录

子模块划分：
- core.py     DanmakuTTSService 服务主体（线程模型 / 事件总线 / 过滤器 / 队列）
- danmaku.py  blivedm 封装（房间信息、连接、自动重连、消息归一化）
- tts.py      edge-tts 封装（文本清洗、合成、音色列表缓存）
- player.py   pygame 顺序播放器（独立线程）
- config.py   config.json 读写（默认值 + 深合并局部更新）
"""

from .core import DanmakuTTSService

__all__ = ["DanmakuTTSService"]
__version__ = "1.0.1"
