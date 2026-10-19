import { join } from 'node:path'
import { BrowserWindow, shell } from 'electron'

/**
 * 建立主視窗。
 * 安全設定：contextIsolation 開啟、nodeIntegration 關閉、sandbox 開啟，
 * renderer 僅能透過 preload 暴露的 contextBridge API 與 main 溝通。
 */
export function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'line-todo',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.on('ready-to-show', () => {
    win.show()
  })

  // 外部連結用系統瀏覽器開，不在 app 內導航
  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 開發模式由 electron-vite 注入 ELECTRON_RENDERER_URL；打包後載入本地 html
  if (!process.env.ELECTRON_RENDERER_URL) {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  } else {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  }

  return win
}
