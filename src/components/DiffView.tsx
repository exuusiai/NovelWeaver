export function DiffView({
  left,
  right,
  hint = '− 仅当前版本（恢复后失去） · + 仅该历史版本',
}: {
  left: string
  right: string
  hint?: string
}) {
  // 段落级对比（LCS 对齐，零依赖）：del=仅当前版本（恢复后失去），add=仅历史版本
  const split = (text: string) =>
    text
      .split(/\n+/)
      .map((p) => p.trim())
      .filter(Boolean)
  const a = split(left)
  const b = split(right)
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1)
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  const ops: Array<{ type: 'same' | 'add' | 'del'; text: string }> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'same', text: a[i] })
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', text: a[i] })
      i += 1
    } else {
      ops.push({ type: 'add', text: b[j] })
      j += 1
    }
  }
  while (i < n) {
    ops.push({ type: 'del', text: a[i] })
    i += 1
  }
  while (j < m) {
    ops.push({ type: 'add', text: b[j] })
    j += 1
  }
  return (
    <div className="history-diff">
      <p className="diff-hint">{hint}</p>
      {ops.map((op, index) => (
        <p key={index} className={`diff-${op.type}`}>
          {op.type === 'del' ? '− ' : op.type === 'add' ? '+ ' : ''}
          {op.text}
        </p>
      ))}
    </div>
  )
}
