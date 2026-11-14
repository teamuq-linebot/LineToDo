import type { loginWithQR } from '@evex-dev/linejs'

/**
 * The name LINE shows for this login (the device list and the "new login" notice): the systemName and modelName of the QR v3 login.
 * LINEJS 3.6.4 has no option for it — loginWithQR → requestSQR2 → qrCodeLoginV2ForSecure(sqr, nonce) leaves its defaults
 * (modelName "evex-device", systemName "linejs-v2") — so the QR login is assembled here from the same LINEJS parts and the name is
 * set on this login's own Login instance only. Nothing in node_modules or any other LINEJS client changes; the device type stays
 * the caller's (ANDROIDSECONDARY). The session restore (loginWithAuthToken) sends no name and is not touched.
 */
export const LINE_LOGIN_DEVICE_NAME = '快組隊 人人有AI LINE待辦管理'

type QrCodeLoginV2ForSecure = (authSessionId: string, nonce: string, modelName?: string, systemName?: string, autoLoginIsRequired?: boolean) => Promise<unknown>

/**
 * Makes `loginProcess` (a LINEJS Login instance) send LINE_LOGIN_DEVICE_NAME as both modelName and systemName. Fails closed: a LINEJS
 * whose Login has no qrCodeLoginV2ForSecure throws here, before any QR is shown, instead of logging in under the default name.
 */
export function nameQrLogin(loginProcess: { qrCodeLoginV2ForSecure?: QrCodeLoginV2ForSecure }): void {
  const original = loginProcess.qrCodeLoginV2ForSecure
  if (typeof original !== 'function') throw Object.assign(new Error('LINEJS QR 登入介面不符，無法設定裝置名稱'), { code: 'LINEJS_LOGIN_NAME_UNSUPPORTED' })
  loginProcess.qrCodeLoginV2ForSecure = (authSessionId, nonce, _modelName, _systemName, autoLoginIsRequired) =>
    original.call(loginProcess, authSessionId, nonce, LINE_LOGIN_DEVICE_NAME, LINE_LOGIN_DEVICE_NAME, autoLoginIsRequired)
}

/**
 * LINEJS 3.6.4 loginWithQR (dist/client/mod.mjs) with the device name set; same arguments, events and result. The QR login is forced
 * to v3 (requestSQR2, the only path that sends a name): for ANDROIDSECONDARY that is the path LINEJS picks anyway. LINEJS is loaded on
 * first use, as before.
 */
export const loginWithNamedQR: typeof loginWithQR = async (opts, init) => {
  const [{ BaseClient }, { Client }] = await Promise.all([import('@evex-dev/linejs/base'), import('@evex-dev/linejs')])
  const base = new BaseClient({ fetch: init.fetch, device: init.device, version: init.version, endpoint: init.endpoint, storage: init.storage, legy: init.legy })
  nameQrLogin(base.loginProcess)
  base.on('qrcall', opts.onReceiveQRUrl)
  base.on('pincall', opts.onPincodeRequest)
  await base.loginProcess.withQrCode({ v3: true })
  await base.loginProcess.ready()
  return new Client(base)
}
