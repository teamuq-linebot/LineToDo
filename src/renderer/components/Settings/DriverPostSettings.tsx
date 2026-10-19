import { useId } from 'react'
import type { DriverPostSettings as DriverPostSettingsValue, SettingsView } from '../../types/api'

/**
 * DriverPostSettings — 設定頁「填入 LINE」區塊（driver_post；已核可原型 ui-prototype.html 狀態 10、ui-decisions.md）。
 *
 *   ① 總開關「啟用『填入 LINE』」
 *   ② 「填入之後」：只填入（已選）；自動送出＝停用＋「尚未開放」（ui-decisions 第 3 點）。main 端 mode 一律正規化成 fillOnly。
 *   ③ 「開啟後以 DB 檢查是否有其他聊天室被標成已讀」（verifyReadByDb，預設開）
 *   ④ 使用前須知
 * 總開關關閉時 ②③ 淡化並停用（沿用「對帳範圍」的做法）。變更立即經 onPatch → api.settings.update 落檔。
 */
export function DriverPostSettings({
  view,
  onPatch
}: {
  view: SettingsView
  onPatch: (p: Partial<DriverPostSettingsValue>) => void
}): JSX.Element {
  const uid = useId()
  const dp = view.driverPost
  const on = dp.enabled
  const ids = {
    title: `${uid}-title`,
    enabled: `${uid}-enabled`,
    enabledHint: `${uid}-enabled-hint`,
    sendHint: `${uid}-send-hint`,
    verify: `${uid}-verify`,
    verifyHint: `${uid}-verify-hint`
  }
  return (
    <section className="set-section" aria-labelledby={ids.title}>
      <div className="set-section-title">
        <span id={ids.title}>填入 LINE</span>
      </div>

      <div className="set-row">
        <div className="set-row-main">
          <label className="set-label" htmlFor={ids.enabled}>
            啟用「填入 LINE」
          </label>
          <span className="set-hint muted" id={ids.enabledHint}>
            在「草擬回覆」對話框加上「填入 LINE」按鈕：自動在 LINE 開啟該聊天室，把草稿填進輸入框。<strong>不會送出</strong>
            ，Enter 一律由你自己按。
          </span>
        </div>
        <div className="set-row-ctl">
          <label className="switch">
            <input
              type="checkbox"
              role="switch"
              id={ids.enabled}
              aria-describedby={ids.enabledHint}
              checked={on}
              onChange={(e) => onPatch({ enabled: e.target.checked })}
            />
            <span className="slider"></span>
          </label>
        </div>
      </div>

      <div className={`set-row child${on ? '' : ' disabled'}`}>
        <fieldset className="prov-cards" style={{ flex: 1 }} disabled={!on}>
          <legend>填入之後</legend>
          <label className="prov-card sel">
            <input type="radio" name={`${uid}-mode`} value="fillOnly" checked readOnly />
            <span className="prov-card-body">
              <span className="prov-name">只填入，由你自己在 LINE 按 Enter 送出</span>
              <span className="prov-sub">填入後會切回 line-todo，並提供「從 LINE 清除這段草稿」。</span>
            </span>
          </label>
          <label className="prov-card locked">
            <input type="radio" name={`${uid}-mode`} value="fillAndSend" disabled aria-describedby={ids.sendHint} />
            <span className="prov-card-body">
              <span className="prov-name">填入並自動送出</span>
              <span className="prov-sub" id={ids.sendHint}>
                要等有更可靠的聊天室辨識方式才會開放，目前無法開啟。
              </span>
            </span>
            <span className="prov-speed">尚未開放</span>
          </label>
        </fieldset>
      </div>

      <div className={`set-row child${on ? '' : ' disabled'}`}>
        <div className="set-row-main">
          <label className="set-label" htmlFor={ids.verify}>
            開啟後以 DB 檢查是否有其他聊天室被標成已讀 <span className="cost-chip">每次多約 1–1.7 秒</span>
          </label>
          <span className="set-hint muted" id={ids.verifyHint}>
            開啟聊天室後，再讀一次 LINE 的本機資料（DB），看看這段時間有沒有<strong>別的</strong>
            聊天室從未讀變成已讀；有的話代表可能開錯了，就不填入。這個檢查只會讓流程停下，不會讓原本無法確認的情況變成通過；只有開錯的聊天室原本有未讀訊息時才偵測得到。預設開啟，建議保持。
          </span>
        </div>
        <div className="set-row-ctl">
          <label className="switch">
            <input
              type="checkbox"
              role="switch"
              id={ids.verify}
              aria-describedby={ids.verifyHint}
              checked={dp.verifyReadByDb}
              disabled={!on}
              onChange={(e) => onPatch({ verifyReadByDb: e.target.checked })}
            />
            <span className="slider"></span>
          </label>
        </div>
      </div>

      <div className={`set-notice${on ? '' : ' dep-off'}`}>
        <span className="set-notice-icon" aria-hidden="true">
          ℹ
        </span>
        <div className="set-notice-body">
          <div className="set-notice-title">使用前須知</div>
          <ul>
            <li>會讓 LINE 跳到前景，並點擊聊天列表中的一列（滑鼠會移動一下再回到原位）。開啟的聊天室會被標為已讀。</li>
            <li>
              要填入的聊天室必須在 LINE 聊天列表<strong>目前的畫面上看得到</strong>。看不到時會告訴你往上或往下捲約幾列，程式不會自己捲動。
            </li>
            <li>不會使用 LINE 的搜尋框；搜尋框有字時會請你先清空。</li>
            <li>會讀取 LINE 本機資料中的聊天室順序（不讀訊息內容），並在記憶體中辨識聊天列表畫面上的聊天室名稱；不存成檔案，也不寫進記錄。</li>
            <li>任何一步無法確認就會停止，你可以改用「複製」自行貼上。每次約 13–20 秒。</li>
          </ul>
        </div>
      </div>
    </section>
  )
}
