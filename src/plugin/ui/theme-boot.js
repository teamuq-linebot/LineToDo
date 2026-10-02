// 防閃爍：render 前先套用主題（G-01）。外掛 view 的 CSP 不允許 inline，所以是外部檔（script-src 'self'）。
// 規則與 src/renderer/lib/theme.ts（外掛：defaultSource 'system'）相同：有手動選擇（lt-theme）就用它，否則跟著作業系統外觀（prefers-color-scheme）。
// 同時設定 color-scheme，原生下拉選單與捲軸也跟著主題。之後的系統外觀變更由 React 端的 useTheme 處理。
(function () {
  var theme = 'dark'
  try {
    var stored = localStorage.getItem('lt-theme')
    if (stored === 'light' || stored === 'dark') theme = stored
    else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) theme = 'light'
  } catch (e) {
    theme = 'dark'
  }
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
})()
