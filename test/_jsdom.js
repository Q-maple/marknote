/*
 * 统一加载 jsdom：优先用工程里装的，其次 $JSDOM_PATH，最后退回本机临时目录。
 * 这样 `npm i jsdom` 和「不装也能跑」两种情况下测试都能用。
 */
module.exports = function loadJsdom() {
  const candidates = ['jsdom', process.env.JSDOM_PATH, '/tmp/mntest/node_modules/jsdom'].filter(Boolean);
  for (const name of candidates) {
    try {
      return require(name);
    } catch (_e) {
      /* 试下一个 */
    }
  }
  return null;
};
