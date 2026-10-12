#!/usr/bin/env python3
"""从 manifest.json 派生一份 Chromium（Chrome / Edge / Brave）能加载的清单。

为什么要分开：Chromium 的 background 解析里有一句
    if (background_solution_sum > 1) return false;   // 见 background_info.cc
也就是说 scripts 和 service_worker 同时出现会直接加载失败；
反过来 Chromium MV3 又不认 Firefox 的 background.scripts。
所以两个浏览器必须用两份清单，这里以 manifest.json 为唯一事实来源自动派生。
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "manifest.json"
MAX_SUGGESTED_KEYS = 4  # Chromium 只接受 4 个带建议快捷键的命令


def build(manifest: dict) -> dict:
    out = json.loads(json.dumps(manifest))  # 深拷贝

    bg = out.get("background", {})
    scripts = bg.get("scripts") or ["src/background/background.js"]
    # Chromium 只接受一个 service_worker，取 scripts 里的**最后一个**当入口：
    # Firefox 按顺序加载、共享同一个全局，最后一个才是 background.js；
    # 排在前面的公共脚本由 background.js 里的 importScripts() 补上。
    out["background"] = {"service_worker": bg.get("service_worker") or scripts[-1]}

    # Firefox 专有键，Chromium 不认识
    out.pop("sidebar_action", None)
    out.pop("browser_specific_settings", None)

    dropped = []
    commands = out.get("commands", {})
    with_key = [k for k, v in commands.items() if v.get("suggested_key")]
    for key in with_key[MAX_SUGGESTED_KEYS:]:
        commands[key].pop("suggested_key", None)
        dropped.append(key)
    if dropped:
        out["_note_dropped_suggested_keys"] = dropped  # 仅注释用途，见下方 pop

    out.pop("_note_dropped_suggested_keys", None)
    return out


def main() -> int:
    manifest = json.loads(SRC.read_text(encoding="utf-8"))
    chrome = build(manifest)
    text = json.dumps(chrome, ensure_ascii=False, indent=2) + "\n"
    if len(sys.argv) > 1 and sys.argv[1] == "--write":
        (ROOT / "manifest.chrome.json").write_text(text, encoding="utf-8")
        print(f"已写入 manifest.chrome.json（{len(text)} 字节）")
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
