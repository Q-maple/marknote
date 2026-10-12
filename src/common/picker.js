/*
 * MarkNote — 取色器
 *
 * 一个自包含的颜色选择控件：色环（色相）+ 饱和/明度方块 + RGB / HEX / 系统取色器输入 +
 * 常用色板。样式跟着组件一起注入，所以既能塞进内容脚本的 shadow DOM（页面里），
 * 也能直接放在扩展页面（弹窗 / 管理页）里用。
 *
 * 用法：
 *   const picker = MN.createColorPicker({
 *     root: shadowRoot,                       // 样式注入到哪里，默认 document
 *     value: '#3b5bdb',
 *     onPick(hex) {},   // 点「应用」
 *     onSave(hex) {},   // 点「存为常用色」（不传就不显示这个按钮）
 *     onDelete(hex) {}, // 删掉一个常用色（不传就没有删除入口）
 *     onCancel() {}     // 点「取消」
 *   });
 *   box.appendChild(picker.el);
 */
(function () {
  'use strict';

  const MN = (globalThis.MN = globalThis.MN || {});
  if (MN.createColorPicker) return;

  const CSS = `
  .mn-pk {
    --mn-pk-bg: #fff;
    display: flex; flex-direction: column; gap: 9px;
    width: 320px; max-width: 100%; padding: 12px; border-radius: 12px;
    background: var(--mn-pk-bg); color: #1f2937;
    font: 13px/1.45 -apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    box-shadow: 0 10px 30px rgba(15, 23, 42, .22), 0 0 0 1px rgba(15, 23, 42, .09);
  }
  .mn-pk * { box-sizing: border-box; }
  .mn-pk:focus { outline: none; }
  .mn-pk-top { display: flex; gap: 12px; align-items: stretch; }
  .mn-pk-ring {
    position: relative; width: 118px; height: 118px; flex: none;
    border-radius: 50%; cursor: crosshair; touch-action: none;
    background: conic-gradient(from 0deg,
      hsl(0,100%,50%) 0deg, hsl(60,100%,50%) 60deg, hsl(120,100%,50%) 120deg,
      hsl(180,100%,50%) 180deg, hsl(240,100%,50%) 240deg, hsl(300,100%,50%) 300deg,
      hsl(360,100%,50%) 360deg);
    box-shadow: inset 0 0 0 1px rgba(15, 23, 42, .12);
  }
  .mn-pk-ring::after {
    content: ''; position: absolute; inset: 17px; border-radius: 50%;
    background: var(--mn-pk-bg); box-shadow: inset 0 0 0 1px rgba(15, 23, 42, .12);
  }
  .mn-pk-ring-dot {
    position: absolute; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%;
    border: 2px solid #fff; box-shadow: 0 0 0 1px rgba(0, 0, 0, .4); pointer-events: none; z-index: 1;
  }
  .mn-pk-sv {
    position: relative; flex: 1; min-width: 0; height: 118px; border-radius: 9px;
    overflow: hidden; cursor: crosshair; touch-action: none; background: #f00;
  }
  .mn-pk-sv .w { position: absolute; inset: 0; background: linear-gradient(to right, #fff, rgba(255,255,255,0)); }
  .mn-pk-sv .b { position: absolute; inset: 0; background: linear-gradient(to top, #000, rgba(0,0,0,0)); }
  .mn-pk-sv-dot {
    position: absolute; width: 13px; height: 13px; margin: -6.5px 0 0 -6.5px; border-radius: 50%;
    border: 2px solid #fff; box-shadow: 0 0 0 1px rgba(0, 0, 0, .45); pointer-events: none; z-index: 1;
  }
  .mn-pk-fields { display: flex; gap: 6px; align-items: flex-end; }
  .mn-pk-field { display: flex; flex-direction: column; gap: 2px; font-size: 10.5px; opacity: .72; }
  .mn-pk-field input {
    font: inherit; font-size: 12.5px; padding: 4px 6px; border-radius: 6px;
    border: 1px solid rgba(120, 130, 150, .45); background: transparent; color: inherit;
  }
  .mn-pk-field input:focus { outline: 2px solid rgba(59, 91, 219, .45); outline-offset: 0; }
  /* 数字框藏掉上下箭头：那对箭头会吃掉宽度，255 这种三位数就被裁掉了 */
  .mn-pk-field.rgb { width: 54px; flex: none; }
  .mn-pk-field.rgb input {
    width: 100%; text-align: center; -moz-appearance: textfield; appearance: textfield;
  }
  .mn-pk-field.rgb input::-webkit-outer-spin-button,
  .mn-pk-field.rgb input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  .mn-pk-field.hex { flex: 1 1 84px; min-width: 84px; }
  .mn-pk-field.native { flex: none; }
  .mn-pk-field input[type='color'] { width: 38px; height: 27px; padding: 1px; cursor: pointer; }
  .mn-pk-palette { display: flex; flex-wrap: wrap; gap: 6px; min-height: 22px; }
  .mn-pk-sw {
    position: relative; width: 22px; height: 22px; padding: 0; border-radius: 50%; cursor: pointer;
    border: 2px solid transparent; box-shadow: inset 0 0 0 1px rgba(0, 0, 0, .16);
  }
  .mn-pk-sw[data-active='1'] { border-color: #3b5bdb; }
  /* 自定义色右上角的删除钮：平时藏起来，鼠标移上去才出现 */
  .mn-pk-sw-del {
    position: absolute; top: -5px; right: -5px; width: 13px; height: 13px; border-radius: 50%;
    display: none; align-items: center; justify-content: center;
    font-size: 10px; line-height: 1; font-weight: 700;
    background: #3f4756; color: #fff; box-shadow: 0 0 0 1.5px var(--mn-pk-bg); cursor: pointer;
  }
  .mn-pk-sw.mn-pk-sw-custom:hover .mn-pk-sw-del,
  .mn-pk-sw.mn-pk-sw-custom:focus-within .mn-pk-sw-del { display: flex; }
  .mn-pk-hint { font-size: 10.5px; opacity: .6; margin: -2px 0 0; }
  .mn-pk-actions { display: flex; gap: 6px; align-items: center; }
  .mn-pk-actions button {
    font: inherit; font-size: 12.5px; padding: 5px 9px; border-radius: 7px;
    border: none; background: none; color: inherit; cursor: pointer;
  }
  .mn-pk-actions button:hover { background: rgba(120, 130, 150, .16); }
  .mn-pk-actions .mn-pk-save { margin-right: auto; border: 1px dashed rgba(120, 130, 150, .6); }
  .mn-pk-actions .mn-pk-apply { background: #3b5bdb; color: #fff; font-weight: 600; }
  .mn-pk-actions .mn-pk-apply:hover { background: #3451c6; }
  @media (prefers-color-scheme: dark) {
    .mn-pk {
      --mn-pk-bg: #1f2430;
      color: #e5e7eb;
      box-shadow: 0 10px 30px rgba(0, 0, 0, .55), 0 0 0 1px rgba(255, 255, 255, .1);
    }
  }`;

  const TEMPLATE = `
    <div class="mn-pk-top">
      <div class="mn-pk-ring" data-role="ring"><span class="mn-pk-ring-dot" data-role="ringdot"></span></div>
      <div class="mn-pk-sv" data-role="sv">
        <span class="w"></span><span class="b"></span>
        <span class="mn-pk-sv-dot" data-role="svdot"></span>
      </div>
    </div>
    <div class="mn-pk-fields">
      <label class="mn-pk-field rgb">R<input type="number" min="0" max="255" step="1" data-ch="r" /></label>
      <label class="mn-pk-field rgb">G<input type="number" min="0" max="255" step="1" data-ch="g" /></label>
      <label class="mn-pk-field rgb">B<input type="number" min="0" max="255" step="1" data-ch="b" /></label>
      <label class="mn-pk-field hex">HEX<input type="text" spellcheck="false" maxlength="7" placeholder="#rrggbb" data-ch="hex" /></label>
      <label class="mn-pk-field native" title="用系统取色器（色轮 / 吸管）">系统<input type="color" data-ch="native" /></label>
    </div>
    <div class="mn-pk-palette" data-role="palette"></div>
    <div class="mn-pk-hint" data-role="hint" hidden></div>
    <div class="mn-pk-actions">
      <button type="button" class="mn-pk-save" data-pk="save">存为常用色</button>
      <button type="button" data-pk="cancel">取消</button>
      <button type="button" class="mn-pk-apply" data-pk="apply">应用</button>
    </div>`;

  function ensureStyle(root) {
    const doc = root && root.ownerDocument ? root.ownerDocument : document;
    const host = root && typeof root.querySelector === 'function' ? root : doc;
    if (host.querySelector('style[data-mn-picker]')) return;
    const style = doc.createElement('style');
    style.setAttribute('data-mn-picker', '1');
    style.textContent = CSS;
    if (host === doc) (doc.head || doc.documentElement).appendChild(style);
    else host.appendChild(style);
  }

  MN.createColorPicker = function createColorPicker(opts) {
    const options = opts || {};
    const el = document.createElement('div');
    el.className = 'mn-pk';
    el.tabIndex = -1; // 只是为了能接住焦点，不抢用户想填的那个输入框
    el.innerHTML = TEMPLATE;
    ensureStyle(options.root || document);

    const refs = {
      ring: el.querySelector('[data-role="ring"]'),
      ringDot: el.querySelector('[data-role="ringdot"]'),
      sv: el.querySelector('[data-role="sv"]'),
      svDot: el.querySelector('[data-role="svdot"]'),
      palette: el.querySelector('[data-role="palette"]'),
      hint: el.querySelector('[data-role="hint"]'),
      r: el.querySelector('[data-ch="r"]'),
      g: el.querySelector('[data-ch="g"]'),
      b: el.querySelector('[data-ch="b"]'),
      hex: el.querySelector('[data-ch="hex"]'),
      native: el.querySelector('[data-ch="native"]')
    };
    const win = el.ownerDocument.defaultView || globalThis;

    /** 当前选中的颜色（#rrggbb）与它的 HSV，两套状态始终同步。 */
    let current = '#ffe066';
    let hsv = { h: 48, s: 0.6, v: 1 };
    let drag = null;

    const activeEl = () => {
      try {
        const r = el.getRootNode && el.getRootNode();
        return (r && r.activeElement) || el.ownerDocument.activeElement;
      } catch (_e) {
        return null;
      }
    };

    function renderPalette() {
      const box = refs.palette;
      box.innerHTML = '';
      let custom = 0;
      MN.allColors().forEach((c) => {
        const sw = document.createElement('button');
        sw.type = 'button';
        sw.className = 'mn-pk-sw' + (c.custom ? ' mn-pk-sw-custom' : '');
        sw.dataset.color = c.id;
        sw.title = c.custom && options.onDelete ? `${c.label}（自定义）· 右键或点右上角 × 可删除` : c.custom ? `${c.label}（自定义）` : c.label;
        sw.style.background = c.light;
        if (String(c.light).toLowerCase() === current) sw.dataset.active = '1';
        sw.addEventListener('click', () => setFromHex(c.light, false));
        if (c.custom) {
          custom += 1;
          if (options.onDelete) {
            // 删除自定义色：右上角的小 ×，或直接右键
            const del = document.createElement('span');
            del.className = 'mn-pk-sw-del';
            del.textContent = '×';
            del.title = '从常用色里删除（已经划好的线不受影响）';
            del.addEventListener('click', (e) => {
              e.preventDefault();
              e.stopPropagation();
              removeCustom(c.id);
            });
            sw.appendChild(del);
            sw.addEventListener('contextmenu', (e) => {
              e.preventDefault();
              e.stopPropagation();
              removeCustom(c.id);
            });
            sw.addEventListener('keydown', (e) => {
              if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                removeCustom(c.id);
              }
            });
          }
        }
        box.appendChild(sw);
      });
      const hint = refs.hint;
      if (hint) {
        hint.hidden = !(custom && options.onDelete);
        hint.textContent = '自定义色：鼠标移上去点右上角 × ，或直接右键，就能从常用色里删掉';
      }
    }

    /** 从常用色板里删掉一个自定义色（当前选中的颜色不变，只是不再出现在色板里）。 */
    function removeCustom(hex) {
      if (!options.onDelete) return;
      options.onDelete(hex);
      renderPalette();
    }

    function render() {
      const rgb = MN.hsvToRgb(hsv);
      current = MN.toHex(rgb);
      refs.sv.style.background = MN.toHex(MN.hsvToRgb({ h: hsv.h, s: 1, v: 1 }));
      refs.svDot.style.left = hsv.s * 100 + '%';
      refs.svDot.style.top = (1 - hsv.v) * 100 + '%';
      const rad = (hsv.h * Math.PI) / 180;
      refs.ringDot.style.left = 50 + Math.sin(rad) * 43 + '%';
      refs.ringDot.style.top = 50 - Math.cos(rad) * 43 + '%';
      const focused = activeEl();
      if (focused !== refs.r) refs.r.value = rgb.r;
      if (focused !== refs.g) refs.g.value = rgb.g;
      if (focused !== refs.b) refs.b.value = rgb.b;
      if (focused !== refs.hex) refs.hex.value = current;
      try {
        if (focused !== refs.native) refs.native.value = current;
      } catch (_e) {
        /* 有些环境不让给 color input 赋任意值 */
      }
      renderPalette();
    }

    function emit() {
      if (options.onInput) options.onInput(current);
    }

    /** 从颜色字符串更新整套状态。silent=true 时不触发 onInput。 */
    function setFromHex(input, silent) {
      const rgb = MN.parseColor(input);
      if (!rgb) return false;
      hsv = MN.rgbToHsv(rgb);
      render();
      if (!silent) emit();
      return true;
    }

    /* ---- 色环：按下 / 拖动改色相 ---- */

    function pickRing(e) {
      const rect = refs.ring.getBoundingClientRect();
      if (!rect.width) return;
      const dx = e.clientX - (rect.left + rect.width / 2);
      const dy = e.clientY - (rect.top + rect.height / 2);
      if (!dx && !dy) return;
      let deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
      if (deg < 0) deg += 360;
      hsv.h = deg;
      render();
      emit();
    }

    function pickSv(e) {
      const rect = refs.sv.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      hsv.s = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      hsv.v = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
      render();
      emit();
    }

    /** 点在色环中间的空洞上时不要改色相（各自仍要继续拖动） */
    function inRingHole(e) {
      const rect = refs.ring.getBoundingClientRect();
      if (!rect.width) return false;
      const dx = e.clientX - (rect.left + rect.width / 2);
      const dy = e.clientY - (rect.top + rect.height / 2);
      return Math.sqrt(dx * dx + dy * dy) < rect.width * 0.32;
    }

    function onDown(kind) {
      return (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        if (kind === 'ring' && inRingHole(e)) return;
        drag = kind;
        if (e.preventDefault) e.preventDefault();
        const target = kind === 'ring' ? refs.ring : refs.sv;
        if (target.setPointerCapture && e.pointerId !== undefined) {
          try {
            target.setPointerCapture(e.pointerId);
          } catch (_e) {
            /* 忽略 */
          }
        }
        kind === 'ring' ? pickRing(e) : pickSv(e);
      };
    }

    const onMove = (e) => {
      if (!drag) return;
      drag === 'ring' ? pickRing(e) : pickSv(e);
    };
    const onUp = () => {
      drag = null;
    };

    refs.ring.addEventListener('pointerdown', onDown('ring'));
    refs.sv.addEventListener('pointerdown', onDown('sv'));
    win.addEventListener('pointermove', onMove, true);
    win.addEventListener('pointerup', onUp, true);
    win.addEventListener('pointercancel', onUp, true);

    /* ---- RGB / HEX / 系统取色器 ---- */

    ['r', 'g', 'b'].forEach((k) => {
      refs[k].addEventListener('input', () => {
        const rgb = { r: refs.r.value, g: refs.g.value, b: refs.b.value };
        if (!MN.normalizeHex(rgb)) return;
        setFromHex(rgb, true);
        emit();
      });
      refs[k].addEventListener('blur', () => render());
    });

    refs.hex.addEventListener('input', () => {
      if (MN.normalizeHex(refs.hex.value)) setFromHex(refs.hex.value, true);
    });
    refs.hex.addEventListener('change', () => {
      if (!setFromHex(refs.hex.value, false)) render();
    });
    refs.hex.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (options.onPick && setFromHex(refs.hex.value, false)) options.onPick(current);
      }
    });

    refs.native.addEventListener('input', () => setFromHex(refs.native.value, false));

    /* ---- 底部按钮 ---- */

    const saveBtn = el.querySelector('[data-pk="save"]');
    if (options.onSave) saveBtn.addEventListener('click', () => options.onSave(current));
    else saveBtn.remove();
    el.querySelector('[data-pk="cancel"]').addEventListener('click', () => options.onCancel && options.onCancel());
    el.querySelector('[data-pk="apply"]').addEventListener('click', () => options.onPick && options.onPick(current));

    // 组件内部的点击不要被宿主的委托处理器当成页面操作
    el.addEventListener('click', (e) => e.stopPropagation());

    setFromHex(options.value || '#ffe066', true);

    return {
      el,
      get value() {
        return current;
      },
      setValue(v) {
        setFromHex(v, true);
      },
      /** 色板被外部改了（加 / 删了常用色）之后重画 */
      refresh() {
        render();
      },
      focus() {
        try {
          el.focus({ preventScroll: true });
        } catch (_e) {
          try {
            el.focus();
          } catch (_e2) {
            /* 忽略 */
          }
        }
      },
      destroy() {
        win.removeEventListener('pointermove', onMove, true);
        win.removeEventListener('pointerup', onUp, true);
        win.removeEventListener('pointercancel', onUp, true);
        if (el.parentNode) el.parentNode.removeChild(el);
      }
    };
  };
})();
