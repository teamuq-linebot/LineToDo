// 防閃爍：render 前先套用主題（預設深色）。standalone 的 src/renderer/index.html 把同一段放在 inline script 並用 CSP sha256 釘選；
// 外掛 view 的 CSP 不允許 inline，所以改成外部檔（script-src 'self'）。邏輯與 standalone 相同。
try {
  var t = localStorage.getItem('lt-theme')
  document.documentElement.dataset.theme = t === 'light' ? 'light' : 'dark'
} catch (e) {
  document.documentElement.dataset.theme = 'dark'
}
