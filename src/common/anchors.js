/*
 * MarkNote — 文本锚点
 *
 * 核心问题：怎么在页面刷新、DOM 变化之后，仍然找得到当初划线的那段文字。
 *
 * 做法（和 Text Fragment / Hypothesis 的思路一致）：
 *   1. 把页面里可划线的文本节点串成一条「虚拟文本」，每个文本节点在其中有 [start, end) 区间；
 *   2. 一条划线 = 虚拟文本上的一段区间，外加 exact / prefix / suffix 三个字符串；
 *   3. 恢复时先按 prefix+exact+suffix 找回位置，失败再全页找 exact（多处则取离原位置最近的），
 *      再失败就退回原始偏移量。这样页面上下加了广告、换了版式，划线大多还能自己找回原位。
 *
 * 只在最外层文档里用；穿 shadow DOM 和 contenteditable 不算。
 */
(function () {
  'use strict';

  const MN = (globalThis.MN = globalThis.MN || {});

  const SKIP_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEXTAREA',
    'INPUT',
    'SELECT',
    'OPTION',
    'IFRAME',
    'CANVAS',
    'SVG',
    'MATH'
  ]);

  function isSkipped(node) {
    let el = node.nodeType === 1 ? node : node.parentElement;
    while (el) {
      if (el.nodeType === 1) {
        if (SKIP_TAGS.has(el.tagName)) return true;
        if (el.hasAttribute && el.hasAttribute('data-mn-skip')) return true;
        if (el.isContentEditable) return true;
      }
      el = el.parentElement;
    }
    return false;
  }

  /** 收集可划线的文本节点，并给出它们在虚拟文本里的区间。 */
  function textNodes(root) {
    const out = [];
    if (!root) return out;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        if (isSkipped(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let pos = 0;
    let n;
    while ((n = walker.nextNode())) {
      const len = n.nodeValue.length;
      out.push({ node: n, start: pos, end: pos + len });
      pos += len;
    }
    return out;
  }

  function virtualTextFrom(spans) {
    let s = '';
    spans.forEach((sp) => {
      s += sp.node.nodeValue;
    });
    return s;
  }

  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

  function ancestorChildIndex(node, ancestor) {
    let cur = node;
    while (cur && cur.parentNode !== ancestor) cur = cur.parentNode;
    if (!cur) return -1;
    return Array.prototype.indexOf.call(ancestor.childNodes, cur);
  }

  /**
   * range 与某个文本节点相交后，在这个节点内部的 [起始, 结束) 局部偏移。
   * 返回 [s, e]；s === e 表示不相交。
   */
  function localBounds(range, node) {
    const len = node.nodeValue.length;
    let s;
    let e;

    if (range.startContainer === node) {
      s = clamp(range.startOffset, 0, len);
    } else if (range.startContainer.nodeType === 1 && range.startContainer.contains(node)) {
      const idx = ancestorChildIndex(node, range.startContainer);
      s = idx >= 0 && idx < range.startOffset ? len : 0;
    } else {
      const rel = range.startContainer.compareDocumentPosition(node);
      s = rel & Node.DOCUMENT_POSITION_FOLLOWING ? 0 : len;
    }

    if (range.endContainer === node) {
      e = clamp(range.endOffset, 0, len);
    } else if (range.endContainer.nodeType === 1 && range.endContainer.contains(node)) {
      const idx = ancestorChildIndex(node, range.endContainer);
      e = idx >= 0 && idx < range.endOffset ? len : 0;
    } else {
      // node 排在 range 结尾之后 → 整块都在 range 内；排在之前 → 完全不在
      const rel = range.endContainer.compareDocumentPosition(node);
      e = rel & Node.DOCUMENT_POSITION_FOLLOWING ? 0 : len;
    }

    s = clamp(s, 0, len);
    e = clamp(e, 0, len);
    return [s, e];
  }

  /** range 在虚拟文本上的 [start, end)；找不到返回 null。 */
  function rangeVirtualBounds(range, spans) {
    let sv = null;
    let ev = null;
    spans.forEach((sp) => {
      const [s, e] = localBounds(range, sp.node);
      if (e > s) {
        if (sv === null) sv = sp.start + s;
        ev = sp.start + e;
      }
    });
    if (sv === null) return null;
    return [sv, ev];
  }

  /** 把虚拟文本区间还原成真正的 Range。 */
  function rangeFromVirtual(spans, sv, ev) {
    let startPos = null;
    let endPos = null;
    for (const sp of spans) {
      const len = sp.node.nodeValue.length;
      if (sv >= sp.start && sv <= sp.end && startPos === null && (sv < sp.end || sp === spans[spans.length - 1])) {
        startPos = { node: sp.node, offset: clamp(sv - sp.start, 0, len) };
      }
      if (ev >= sp.start && ev <= sp.end && (ev > sp.start || sp === spans[0])) {
        endPos = { node: sp.node, offset: clamp(ev - sp.start, 0, len) };
      }
    }
    if (!startPos || !endPos) return null;
    const range = document.createRange();
    try {
      range.setStart(startPos.node, startPos.offset);
      range.setEnd(endPos.node, endPos.offset);
    } catch (_e) {
      return null;
    }
    return range.isCollapsed ? null : range;
  }

  const CTX = 40;

  /** 把一个 Range 序列化成可持久化的锚点。 */
  function serializeRange(range, root) {
    const spans = textNodes(root || document.body);
    const bounds = rangeVirtualBounds(range, spans);
    if (!bounds) return null;
    const [sv, ev] = bounds;
    const vt = virtualTextFrom(spans);
    const exact = vt.slice(sv, ev);
    if (!exact.trim()) return null;
    return {
      exact,
      prefix: vt.slice(Math.max(0, sv - CTX), sv),
      suffix: vt.slice(ev, Math.min(vt.length, ev + CTX)),
      startV: sv,
      endV: ev,
      textLength: vt.length
    };
  }

  /**
   * 在一份已算好的 spans / 虚拟文本上，按锚点求出 [start, end)；失败返回 null。
   * 单独抽出来是为了让调用方一次遍历就能同时完成「定位 + 包高亮」。
   */
  function resolveVirtual(anchor, spans, vt) {
    if (!anchor || !anchor.exact || !spans || !spans.length) return null;
    const { exact, prefix, suffix } = anchor;
    let sv = -1;

    const tryNeedle = (needle, offsetInNeedle) => {
      const i = vt.indexOf(needle);
      if (i < 0) return false;
      sv = i + offsetInNeedle;
      return true;
    };

    if (prefix && suffix && !tryNeedle(prefix + exact + suffix, prefix.length)) {
      if (!tryNeedle(prefix + exact, prefix.length) && !tryNeedle(exact + suffix, 0)) {
        sv = -1;
      }
    }

    if (sv < 0) {
      const hits = [];
      let i = vt.indexOf(exact);
      while (i >= 0 && hits.length < 500) {
        hits.push(i);
        i = vt.indexOf(exact, i + 1);
      }
      if (hits.length === 1) sv = hits[0];
      else if (hits.length > 1) {
        const near = typeof anchor.startV === 'number' ? anchor.startV : 0;
        sv = hits.reduce((best, h) => (Math.abs(h - near) < Math.abs(best - near) ? h : best), hits[0]);
      }
    }

    if (sv < 0) {
      // 最后退路：文本没变过，直接用原偏移
      if (typeof anchor.startV === 'number' && anchor.startV < vt.length) {
        const seg = vt.slice(anchor.startV, anchor.startV + exact.length);
        if (seg === exact) sv = anchor.startV;
      }
    }

    if (sv < 0) return null;
    return [sv, sv + exact.length];
  }

  /** 依据锚点找回 Range；失败返回 null。 */
  function resolveAnchor(anchor, root) {
    const spans = textNodes(root || document.body);
    const bounds = resolveVirtual(anchor, spans, virtualTextFrom(spans));
    if (!bounds) return null;
    return rangeFromVirtual(spans, bounds[0], bounds[1]);
  }

  function makeMark(ann, color) {
    const mark = document.createElement('mark');
    mark.className = 'mn-hl';
    mark.dataset.ann = ann.id;
    mark.dataset.color = ann.color;
    if (color) {
      mark.style.setProperty('--mn-bg', color.light);
      mark.style.setProperty('--mn-bg-dark', color.dark);
    }
    return mark;
  }

  /**
   * 把一个 Range 用 <mark> 包起来。
   * 返回创建的 mark 元素数组；一个也没包上（说明整段已被包过或不可见）返回空数组。
   */
  function wrapVirtualRange(spans, sv, ev, ann, color) {
    const created = [];
    spans.forEach((sp) => {
      if (sp.end <= sv || sp.start >= ev) return;
      const node = sp.node;
      if (!node.isConnected || !node.parentNode) return;
      const localStart = Math.max(sv, sp.start) - sp.start;
      const localEnd = Math.min(ev, sp.end) - sp.start;
      if (localEnd <= localStart) return;

      let target = node;
      try {
        // splitText 返回的是后半截：掐头要用返回值，去尾要保留原节点
        if (localStart > 0) target = target.splitText(localStart);
        const keep = localEnd - localStart;
        if (keep < target.nodeValue.length) target.splitText(keep);
      } catch (_e) {
        return;
      }
      const mark = makeMark(ann, color);
      target.parentNode.insertBefore(mark, target);
      mark.appendChild(target);
      created.push(mark);
    });
    return created;
  }

  function wrapRange(range, ann, color, root) {
    const spans = textNodes(root || document.body);
    const bounds = rangeVirtualBounds(range, spans);
    if (!bounds) return [];
    return wrapVirtualRange(spans, bounds[0], bounds[1], ann, color);
  }

  function unwrapMark(mark) {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    try {
      parent.normalize();
    } catch (_e) {
      /* 忽略 */
    }
  }

  function unwrapAnnotation(id, root) {
    const scope = root || document;
    let list = [];
    try {
      list = scope.querySelectorAll('mark.mn-hl[data-ann="' + id + '"]');
    } catch (_e) {
      list = [];
    }
    list.forEach(unwrapMark);
    return list.length;
  }

  function unwrapAll(root) {
    const scope = root || document;
    const list = scope.querySelectorAll('mark.mn-hl');
    list.forEach(unwrapMark);
    return list.length;
  }

  MN.anchors = {
    SKIP_TAGS,
    isSkipped,
    textNodes,
    virtualTextFrom,
    localBounds,
    rangeVirtualBounds,
    rangeFromVirtual,
    serializeRange,
    resolveAnchor,
    resolveVirtual,
    wrapRange,
    wrapVirtualRange,
    unwrapAnnotation,
    unwrapAll,
    unwrapMark
  };
})();
