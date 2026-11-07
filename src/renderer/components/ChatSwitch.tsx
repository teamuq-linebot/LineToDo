interface Props {
  label: string
  checked: boolean
  disabled?: boolean
  busy?: boolean
  onChange: (checked: boolean) => void
  testId?: string
}

/** 標題旁的啟動／關閉開關：role=switch，忙碌時停用並標示 aria-busy。 */
export function ChatSwitch({ label, checked, disabled = false, busy = false, onChange, testId }: Props): JSX.Element {
  return (
    <span className="chat-switch-wrap" data-busy={busy ? 'true' : 'false'} data-testid={testId}>
      <label className="switch">
        <input
          type="checkbox"
          role="switch"
          aria-label={label}
          aria-checked={checked}
          aria-busy={busy}
          checked={checked}
          disabled={disabled || busy}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="slider" />
      </label>
      <span className="chat-switch-state" aria-hidden="true">{checked ? '啟動' : '關閉'}</span>
    </span>
  )
}
