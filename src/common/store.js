/*
 * MarkNote — 本地存储层
 * 数据全部放在 chrome.storage.local（配 unlimitedStorage 权限，不限额）。
 * 每条划线一个 key：ann:<id>，避免整块大对象反复读写。
 */
(function () {
  'use strict';

  const MN = (globalThis.MN = globalThis.MN || {});
  const B = globalThis.browser && globalThis.browser.runtime ? globalThis.browser : null;
  const C = globalThis.chrome;

  /** 统一成 Promise：Firefox 用 browser.*，Chrome 用 chrome.* + 回调。 */
  function call(fn, args) {
    if (B) return fn.apply(B.storage.local, args);
    return new Promise((resolve, reject) => {
      fn.apply(C.storage.local, [
        ...args,
        (res) => {
          const err = C.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(res);
        }
      ]);
    });
  }

  const localGet = (keys) => call(B ? B.storage.local.get : C.storage.local.get, [keys]);
  const localRemove = (keys) => call(B ? B.storage.local.remove : C.storage.local.remove, [keys]);

  /*
   * storage.onChanged 对"自己写的"也会触发，于是本页面改一次颜色，
   * watchExternal 会当成"外部改动"再广播一次，内容和侧边栏就会把整页高亮拆掉重建
   * （页面闪一下，用户当前的选区也没了）。这里记一下自己刚写过哪些 key，
   * 在 onChanged 里把这些跳过。
   */
  const selfWrites = new Map();
  function markSelfWrite(keys) {
    const now = Date.now();
    keys.forEach((k) => selfWrites.set(k, now));
    if (selfWrites.size > 200) {
      for (const [k, t] of selfWrites) if (now - t > 3000) selfWrites.delete(k);
    }
  }
  function wasSelfWrite(key) {
    const t = selfWrites.get(key);
    return !!t && Date.now() - t < 1500;
  }

  const localSet = (obj) => {
    markSelfWrite(Object.keys(obj || {}));
    return call(B ? B.storage.local.set : C.storage.local.set, [obj]);
  };

  const ANN_PREFIX = 'ann:';
  const SETTINGS_KEY = 'settings';

  let cache = null; // Map<id, ann>

  async function loadAll() {
    const all = (await localGet(null)) || {};
    const map = new Map();
    Object.keys(all).forEach((k) => {
      if (k.startsWith(ANN_PREFIX)) map.set(k.slice(ANN_PREFIX.length), all[k]);
    });
    cache = map;
    return map;
  }

  async function ensureCache() {
    if (!cache) await loadAll();
    return cache;
  }

  const store = (MN.store = {
    async all() {
      const map = await ensureCache();
      return [...map.values()];
    },

    async forUrl(url) {
      const key = MN.normalizeUrl(url);
      const map = await ensureCache();
      return [...map.values()]
        .filter((a) => a.url === key)
        .sort((a, b) => (a.anchor ? a.anchor.startV : 0) - (b.anchor ? b.anchor.startV : 0));
    },

    async get(id) {
      const map = await ensureCache();
      return map.get(id) || null;
    },

    async put(ann) {
      const map = await ensureCache();
      const now = Date.now();
      const record = {
        ...ann,
        id: ann.id || MN.uid(),
        createdAt: ann.createdAt || now,
        updatedAt: now
      };
      map.set(record.id, record);
      await localSet({ [ANN_PREFIX + record.id]: record });
      store.emitChanged(record.url);
      return record;
    },

    async patch(id, changes) {
      const map = await ensureCache();
      const old = map.get(id);
      if (!old) return null;
      const record = { ...old, ...changes, updatedAt: Date.now() };
      map.set(id, record);
      await localSet({ [ANN_PREFIX + id]: record });
      store.emitChanged(record.url);
      return record;
    },

    async remove(id) {
      const map = await ensureCache();
      const old = map.get(id);
      map.delete(id);
      await localRemove(ANN_PREFIX + id);
      store.emitChanged(old ? old.url : null);
      return old;
    },

    async removeMany(ids) {
      const map = await ensureCache();
      const urls = new Set();
      ids.forEach((id) => {
        const old = map.get(id);
        if (old) urls.add(old.url);
        map.delete(id);
      });
      await localRemove(ids.map((id) => ANN_PREFIX + id));
      urls.forEach((u) => store.emitChanged(u));
      return ids.length;
    },

    /** 清空某个页面的划线。 */
    async removeForUrl(url) {
      const list = await store.forUrl(url);
      await store.removeMany(list.map((a) => a.id));
      return list.length;
    },

    async exportBundle() {
      const annotations = await store.all();
      return {
        app: 'MarkNote',
        schema: 1,
        exportedAt: new Date().toISOString(),
        settings: await store.getSettings(),
        annotations
      };
    },

    /** mode: 'merge'（默认，按 id 去重）| 'replace' */
    async importBundle(bundle, mode = 'merge') {
      if (!bundle || !Array.isArray(bundle.annotations)) {
        throw new Error('不是有效的 MarkNote 备份文件');
      }
      const map = await ensureCache();
      if (mode === 'replace') {
        await localRemove([...map.keys()].map((id) => ANN_PREFIX + id));
        map.clear();
      }
      const payload = {};
      let added = 0;
      let skipped = 0;
      bundle.annotations.forEach((raw) => {
        if (!raw || !raw.url) return;
        const ann = {
          ...raw,
          id: raw.id || MN.uid(),
          tags: Array.isArray(raw.tags) ? raw.tags : [],
          createdAt: raw.createdAt || Date.now(),
          updatedAt: Date.now()
        };
        if (map.has(ann.id)) {
          skipped += 1;
          return;
        }
        map.set(ann.id, ann);
        payload[ANN_PREFIX + ann.id] = ann;
        added += 1;
      });
      if (added) await localSet(payload);
      store.emitChanged(null);
      return { added, skipped };
    },

    async getSettings() {
      const raw = (await localGet(SETTINGS_KEY)) || {};
      const saved = raw[SETTINGS_KEY] || {};
      const out = { ...MN.DEFAULT_SETTINGS, ...saved };
      // ai 是个对象，得逐字段合并，不能整体被存的覆盖掉
      out.ai = { ...MN.DEFAULT_SETTINGS.ai, ...(saved.ai || {}) };
      // 这两个是开关/枚举，存坏了会让序号渲染出怪样子，读的时候就先掰正
      out.showIndex = !!out.showIndex;
      out.indexMode = MN.normalizeIndexMode(out.indexMode);
      out.copyNoticeAck = !!out.copyNoticeAck;
      out.markdownTemplate = out.markdownTemplate === 'list' ? 'list' : 'quote';
      return out;
    },

    async setSettings(patch) {
      const current = await store.getSettings();
      const next = { ...current, ...patch };
      // 双保险：密钥只存 aiKey，任何情况下都不许混进 settings（settings 是会被导出的）
      delete next.aiKey;
      delete next.apiKey;
      if (patch && 'showIndex' in patch) next.showIndex = !!patch.showIndex;
      if (patch && 'copyNoticeAck' in patch) next.copyNoticeAck = !!patch.copyNoticeAck;
      if (patch && 'indexMode' in patch) next.indexMode = MN.normalizeIndexMode(patch.indexMode);
      if (patch && 'ai' in patch) {
        // ai 是个对象。patch 里只给一个字段时（页面上切模型只会传 model），
        // 必须跟**已存的** ai 合并，否则 enabled / prompt / maxItems 会被一起冲掉。
        const merged = { ...current.ai, ...(patch.ai || {}) };
        delete merged.apiKey;
        delete merged.key;
        delete merged.aiKey;
        next.ai = MN.ai ? MN.ai.normalizeConfig(merged) : merged;
      }
      // 自定义色板只存 #rrggbb 列表，顺手去重、丢掉认不出来的值
      if (patch && 'customColors' in patch) {
        const seen = [];
        (Array.isArray(next.customColors) ? next.customColors : []).forEach((c) => {
          const hex = MN.normalizeHex(typeof c === 'string' ? c : c && (c.light || c.id || c.hex));
          if (hex && seen.indexOf(hex) < 0) seen.push(hex);
        });
        next.customColors = seen;
      }
      await localSet({ [SETTINGS_KEY]: next });
      return next;
    },

    async stats() {
      const all = await store.all();
      const pages = new Set(all.map((a) => a.url));
      const tags = new Set();
      all.forEach((a) => (a.tags || []).forEach((t) => tags.add(t)));
      const bytes = JSON.stringify(all).length;
      return { count: all.length, pageCount: pages.size, tagCount: tags.size, bytes };
    },

    /** 让界面在数据变化后自动刷新。 */
    listeners: new Set(),
    onChange(cb) {
      store.listeners.add(cb);
      return () => store.listeners.delete(cb);
    },
    /**
     * 通知监听者数据变了。
     * origin='local' 表示"这次写入就是本页面自己干的"（DOM 已经就地更新过了），
     * origin='external' 表示别的页面（侧边栏 / 管理页 / 另一个标签页）改的。
     * 内容脚本靠这个区分，避免自己改一次颜色就把整页高亮拆掉重建。
     */
    emitChanged(url, origin = 'local') {
      store.listeners.forEach((cb) => {
        try {
          cb(url, origin);
        } catch (e) {
          console.warn('[MarkNote] listener error', e);
        }
      });
    },

    /** 监听其它页面（侧边栏、管理页）造成的改动。 */
    watchExternal() {
      if (store._watching) return;
      store._watching = true;
      const handler = (changes, area) => {
        if (area !== 'local') return;
        const touched = [];
        Object.keys(changes).forEach((k) => {
          if (k === SETTINGS_KEY) {
            // 设置也会在别的页面被改（自定义色板、默认色…），同样要通知界面
            if (!wasSelfWrite(k)) touched.push(k);
            return;
          }
          if (!k.startsWith(ANN_PREFIX)) return;
          const id = k.slice(ANN_PREFIX.length);
          const val = changes[k].newValue;
          if (cache) {
            if (val) cache.set(id, val);
            else cache.delete(id);
          }
          if (wasSelfWrite(k)) return; // 自己刚写的，界面已经就地更新过了
          touched.push(id);
        });
        if (touched.length) store.emitChanged(null, 'external');
      };
      if (B) B.storage.onChanged.addListener(handler);
      else C.storage.onChanged.addListener(handler);
      store._unwatch = () => {
        if (B) B.storage.onChanged.removeListener(handler);
        else C.storage.onChanged.removeListener(handler);
        store._watching = false;
      };
    }
  });
})();
