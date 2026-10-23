export function Sparkline({ values }) {
  if (values.length < 2) return <svg className="spark" viewBox="0 0 200 40" aria-hidden="true" />
  const mn = Math.min(...values)
  const mx = Math.max(...values)
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * 200
      const y = 36 - ((v - mn) / (mx - mn || 1)) * 32
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg className="spark" viewBox="0 0 200 40" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} />
    </svg>
  )
}

export function Metric({ m, value, flag, values }) {
  const v = parseFloat(value)
  const has = !Number.isNaN(v)
  const zoneLeft = ((m.min - m.lo) / (m.hi - m.lo)) * 100
  const zoneWidth = ((m.max - m.min) / (m.hi - m.lo)) * 100
  const pin = has ? Math.max(0, Math.min(100, ((v - m.lo) / (m.hi - m.lo)) * 100)) : 0
  const bad = flag !== undefined ? flag === '1' : has && (v < m.min || v > m.max)
  const badge = !has ? ['', 'Aguardando'] : bad ? ['bad', 'Fora da faixa'] : ['ok', 'Na faixa']

  return (
    <section className={`panel${m.hero ? ' hero' : ''}`}>
      <div className="mh">
        <h2>{m.name}</h2>
        <span className={`badge ${badge[0]}`}>{badge[1]}</span>
      </div>
      <div className="val">
        <span>{has ? v.toFixed(m.dec) : '--'}</span>
        <small>{m.unit}</small>
      </div>
      <div className="scale">
        <i className="zone" style={{ left: `${zoneLeft}%`, width: `${zoneWidth}%` }} />
        <b className="pin" style={{ left: `${pin}%` }} />
      </div>
      <div className="ticks">
        <span>{m.lo}</span>
        <span>faixa ideal: {m.min} a {m.max}{m.unit}</span>
        <span>{m.hi}</span>
      </div>
      <Sparkline values={values} />
    </section>
  )
}