import { Loader2, X } from 'lucide-react'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export function Button({ className = '', variant = 'primary', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  return <button className={`button button-${variant} ${className}`} {...props} />
}

export function IconButton({ label, children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return <button className={`icon-button ${className}`} title={label} aria-label={label} {...props}>{children}</button>
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) { return <input className={`input ${props.className || ''}`} {...props} /> }
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) { return <textarea className={`textarea ${props.className || ''}`} {...props} /> }

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'teal' | 'amber' | 'red' | 'blue' }) {
  return <span className={`badge badge-${tone}`}>{children}</span>
}

export function EmptyState({ icon, title, text, action }: { icon: ReactNode; title: string; text: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">{icon}</div><h3>{title}</h3><p>{text}</p>{action}</div>
}

export function Modal({ title, children, onClose, footer }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
    <section className="modal" role="dialog" aria-modal="true"><header><h2>{title}</h2><IconButton label="关闭" onClick={onClose}><X size={18} /></IconButton></header><div className="modal-body">{children}</div>{footer && <footer>{footer}</footer>}</section>
  </div>
}

export function LoadingState({ label = '正在处理' }: { label?: string }) {
  return <div className="loading-state" role="status"><Loader2 className="spin" size={18} /><span>{label}</span><i><b /><b /><b /></i></div>
}

type HastNode = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] }

// 把正文中的 [Rn] 标记替换为可悬停的引用芯片：title 提示对应证据的摘要与原文片段，
// 编号越界时明确提示"不在上下文快照中"，让伪造接地在前端即可辨识。
function rehypeCitationChips(summaries: string[]) {
  const pattern = /\[R(\d+)\]/g
  const walk = (node: HastNode) => {
    if (!node.children) return
    node.children = node.children.flatMap((child) => {
      if (child.type === 'text' && typeof child.value === 'string' && child.value.includes('[R')) {
        const parts: HastNode[] = []
        let last = 0
        for (const match of child.value.matchAll(pattern)) {
          const index = Number(match[1])
          if (match.index === undefined) continue
          if (match.index > last) parts.push({ type: 'text', value: child.value.slice(last, match.index) })
          const summary = summaries[index - 1]
          parts.push({
            type: 'element', tagName: 'span',
            properties: { className: ['ref-chip'], title: `R${index} · ${summary || '该编号不在本次上下文快照中（可疑引用）'}` },
            children: [{ type: 'text', value: match[0] }],
          })
          last = match.index + match[0].length
        }
        if (last < child.value.length) parts.push({ type: 'text', value: child.value.slice(last) })
        return parts
      }
      walk(child)
      return [child]
    })
  }
  return () => (tree: HastNode) => walk(tree)
}

export function MarkdownLike({ text, citations }: { text: string; citations?: Array<{ summary?: string; content?: string }> }) {
  const summaries = (citations || []).map((hit) => `${hit.summary || ''}${hit.content ? `｜${hit.content.slice(0, 160)}` : ''}`)
  if (citations?.length) return <div className="generated-content"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeCitationChips(summaries)]}>{text}</ReactMarkdown></div>
  return <div className="generated-content"><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div>
}
