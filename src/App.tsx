import { FormEvent, KeyboardEvent, useState } from 'react'
import { Tldraw } from 'tldraw'
import 'tldraw/tldraw.css'

const overlayStyle = {
  position: 'absolute',
  left: '50%',
  bottom: '24px',
  transform: 'translateX(-50%)',
  width: 'calc(100% - 32px)',
  maxWidth: '600px',
  pointerEvents: 'none',
} as const

const formStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  padding: '12px',
  borderRadius: '18px',
  background: '#ffffff',
  boxShadow: '0 18px 45px rgba(15, 23, 42, 0.16)',
  border: '1px solid rgba(15, 23, 42, 0.08)',
  pointerEvents: 'auto',
} as const

const inputStyle = {
  flex: 1,
  border: '1px solid rgba(148, 163, 184, 0.45)',
  borderRadius: '12px',
  padding: '12px 14px',
  fontSize: '15px',
  outline: 'none',
  transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
} as const

const buttonStyle = {
  border: 'none',
  borderRadius: '12px',
  background: '#111827',
  color: '#ffffff',
  padding: '12px 18px',
  fontSize: '14px',
  fontWeight: 600,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
} as const

export default function App() {
  const [value, setValue] = useState('')

  const handleSubmit = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault()
    const nextValue = value.trim()

    if (!nextValue) return

    console.log(nextValue)
    setValue('')
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      handleSubmit()
    }
  }

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh' }}>
      <Tldraw />

      <div style={overlayStyle}>
        <form style={formStyle} onSubmit={handleSubmit}>
          <input
            type="text"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask AI to help on the canvas..."
            style={inputStyle}
            aria-label="Canvas assistant prompt"
          />
          <button type="submit" style={buttonStyle}>
            Send
          </button>
        </form>
      </div>
    </div>
  )
}
