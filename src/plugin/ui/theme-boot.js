// 防閃爍：render 前先套用主題（G-01）。外掛 view 的 CSP 不允許 inline，所以是外部檔（script-src 'self'）。
// TeamUQ 將宿主主題同步到 Electron nativeTheme；prefers-color-scheme 因而代表目前宿主外觀。忽略舊的 lt-theme 值。
// 同時設定 color-scheme，原生下拉選單與捲軸也跟著主題。之後的宿主外觀變更由 React 端的 useTheme 處理。
(function () {
  var theme = 'dark'
  try {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) theme = 'light'
  } catch (e) {
    theme = 'dark'
  }
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
})()
