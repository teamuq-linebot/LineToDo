import { useLayoutEffect, useRef } from 'react'

export type PurchasePackageId = 'line' | 'schedule'

export function PurchasePage({ selectedPackage, onBack }: { selectedPackage: PurchasePackageId; onBack: () => void }): JSX.Element {
  const selectedRef = useRef<HTMLElement>(null)
  useLayoutEffect(() => { selectedRef.current?.focus() }, [selectedPackage])
  return (
    <section className="purchase-page" aria-labelledby="purchase-page-title">
      <header className="purchase-page-header">
        <div>
          <h2 id="purchase-page-title" tabIndex={-1}>購買方案</h2>
          <p className="purchase-availability" role="status">目前尚未開放購買。價格與付款方式尚未提供。</p>
        </div>
        <button type="button" className="purchase-return" onClick={onBack}>返回聊天</button>
      </header>
      <div className="purchase-plan-list">
        <article className="purchase-plan" ref={selectedPackage === 'line' ? selectedRef : undefined} tabIndex={-1} aria-labelledby="purchase-line-title">
          <h3 id="purchase-line-title">LINE 進階功能包</h3>
          <p className="purchase-plan-billing">一次買斷｜尚未開放購買</p>
          <p>功能範圍包含圖片／檔案自動保存、手動發送（文字、單張圖片與單一一般檔案）及貼圖相關能力。升級不保證補回過去未保存的圖片或檔案。</p>
        </article>
        <article className="purchase-plan" ref={selectedPackage === 'schedule' ? selectedRef : undefined} tabIndex={-1} aria-labelledby="purchase-schedule-title">
          <h3 id="purchase-schedule-title">排程發送擴充包</h3>
          <p className="purchase-plan-billing">一次買斷｜未來規劃</p>
          <p>尚未提供可用功能、價格或付款方式，目前未開放購買。</p>
        </article>
      </div>
    </section>
  )
}
