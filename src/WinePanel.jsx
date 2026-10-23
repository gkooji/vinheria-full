import { useEffect, useRef, useState } from 'react'
import { Metric } from './Metric'
import './WinePanel.css'

const STORAGE = 'adegaVinhos'

// Valores de referência comuns. O usuário ajusta conforme o rótulo ou o produtor.
const COMMON = { hmin: 60, hmax: 75, lmax: 25 }
const PRESETS = {
  Tinto: { tmin: 12, tmax: 18, ...COMMON },
  Branco: { tmin: 8, tmax: 12, ...COMMON },
  Rosé: { tmin: 8, tmax: 12, ...COMMON },
  Espumante: { tmin: 7, tmax: 12, ...COMMON },
}
const KINDS = [...Object.keys(PRESETS), 'Personalizado']

const fmt = (v, d = 0) => v.toFixed(d).replace('.', ',')

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE))
    return { wines: Array.isArray(s?.wines) ? s.wines : [], active: s?.active ?? null }
  } catch {
    return { wines: [], active: null }
  }
}

function newWine(kind = 'Tinto') {
  return { name: '', notes: '', kind, ...(PRESETS[kind] ?? PRESETS.Tinto) }
}

// Converte o cadastro do vinho no formato que o componente Metric entende
function metricsFor(w) {
  return [
    { key: 't', name: 'Temperatura', unit: '°C', min: w.tmin, max: w.tmax, lo: Math.min(0, w.tmin - 5), hi: Math.max(35, w.tmax + 5), dec: 1, hero: true },
    { key: 'h', name: 'Umidade', unit: '%', min: w.hmin, max: w.hmax, lo: Math.min(20, w.hmin - 10), hi: 100, dec: 0 },
    { key: 'l', name: 'Luminosidade', unit: '%', min: 0, max: w.lmax, lo: 0, hi: 100, dec: 0 },
  ]
}

function stats(values, m) {
  if (!values.length) return null
  const sum = values.reduce((a, b) => a + b, 0)
  const inside = values.filter((v) => v >= m.min && v <= m.max).length
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    avg: sum / values.length,
    ok: Math.round((inside / values.length) * 100),
  }
}

// ---------- formulário ----------
function WineDialog({ initial, onSave, onClose }) {
  const ref = useRef(null)
  const [f, setF] = useState(initial)
  const [err, setErr] = useState('')

  useEffect(() => {
    ref.current.showModal()
  }, [])

  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))
  const setKind = (e) => {
    const kind = e.target.value
    setF((s) => ({ ...s, kind, ...(PRESETS[kind] ?? {}) }))
  }

  const submit = (e) => {
    e.preventDefault()
    const w = {
      ...f,
      name: f.name.trim(),
      notes: (f.notes || '').trim(),
      tmin: Number(f.tmin),
      tmax: Number(f.tmax),
      hmin: Number(f.hmin),
      hmax: Number(f.hmax),
      lmax: Number(f.lmax),
    }
    if (w.tmin >= w.tmax) return setErr('A temperatura mínima precisa ser menor que a máxima.')
    if (w.hmin >= w.hmax) return setErr('A umidade mínima precisa ser menor que a máxima.')
    if (w.hmin < 0 || w.hmax > 100 || w.lmax < 0 || w.lmax > 100)
      return setErr('Umidade e luminosidade ficam entre 0 e 100 %.')
    onSave(w)
    ref.current.close()
  }

  return (
    <dialog ref={ref} onClose={onClose} className="wide">
      <form onSubmit={submit}>
        <h2>{initial.id ? 'Editar vinho' : 'Novo vinho'}</h2>

        <label>
          Nome do vinho
          <input type="text" value={f.name} onChange={set('name')} placeholder="Ex.: Cabernet Sauvignon 2019" required />
        </label>

        <label>
          Tipo (preenche as faixas de referência)
          <select value={f.kind} onChange={setKind}>
            {KINDS.map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>

        <div className="pair">
          <label>
            Temperatura mínima (°C)
            <input type="number" step="0.5" value={f.tmin} onChange={set('tmin')} required />
          </label>
          <label>
            Temperatura máxima (°C)
            <input type="number" step="0.5" value={f.tmax} onChange={set('tmax')} required />
          </label>
          <label>
            Umidade mínima (%)
            <input type="number" value={f.hmin} onChange={set('hmin')} required />
          </label>
          <label>
            Umidade máxima (%)
            <input type="number" value={f.hmax} onChange={set('hmax')} required />
          </label>
        </div>

        <label>
          Luminosidade máxima (%)
          <input type="number" value={f.lmax} onChange={set('lmax')} required />
        </label>

        <label>
          Observações (opcional)
          <textarea rows="2" value={f.notes} onChange={set('notes')} placeholder="Ex.: guardar deitado, longe de vibração" />
        </label>

        <p className="hint">
          As faixas de referência são valores comuns de armazenamento. Confira a recomendação do produtor no rótulo.
        </p>
        {err && <p className="err">{err}</p>}

        <div className="actions">
          <button type="button" className="ghost" onClick={() => ref.current.close()}>
            Cancelar
          </button>
          <button className="primary">Salvar</button>
        </div>
      </form>
    </dialog>
  )
}

// ---------- tela ----------
export default function WinePanel({ data, history, send }) {
  const [store, setStore] = useState(load)
  const [dialog, setDialog] = useState(null)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE, JSON.stringify(store))
    } catch {
      /* armazenamento indisponível */
    }
  }, [store])

  const wine = store.wines.find((w) => w.id === store.active) ?? store.wines[0]

  // Envia ao ESP32 o nome e as faixas do vinho selecionado (nome,tmin,tmax,hmin,hmax,lmax).
  // O nome aparece no LCD ao apertar o botão e as faixas passam a valer para LEDs e buzzer.
  useEffect(() => {
    if (!wine || !send) return
    // O LCD não mostra acentos. O Orion rejeita ; < > " ' = ( ) em valores (erro 400),
    // e | e , são separadores do comando, então esses caracteres saem do nome.
    const nome = wine.name
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[|;,<>"'=()]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    send('wine', `${nome},${wine.tmin},${wine.tmax},${wine.hmin},${wine.hmax},${wine.lmax}`)
  }, [wine?.id, wine?.name, wine?.tmin, wine?.tmax, wine?.hmin, wine?.hmax, wine?.lmax]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = (w) =>
    setStore((s) => {
      if (w.id) return { wines: s.wines.map((x) => (x.id === w.id ? w : x)), active: w.id }
      const created = { ...w, id: Date.now().toString(36) }
      return { wines: [...s.wines, created], active: created.id }
    })

  const remove = () => {
    if (!window.confirm(`Excluir "${wine.name}"?`)) return
    setStore((s) => {
      const wines = s.wines.filter((x) => x.id !== wine.id)
      return { wines, active: wines[0]?.id ?? null }
    })
  }

  // Avaliação do vinho selecionado
  const metrics = wine ? metricsFor(wine) : []
  const readings = metrics.map((m) => ({ m, v: parseFloat(data[m.key]) }))
  const hasData = readings.some((r) => !Number.isNaN(r.v))
  const issues = readings.filter((r) => !Number.isNaN(r.v) && (r.v < r.m.min || r.v > r.m.max))

  const issueText = ({ m, v }) =>
    m.key === 'l'
      ? `Luminosidade em ${fmt(v)} %, acima do limite de ${m.max} %.`
      : `${m.name} em ${fmt(v, m.dec)} ${m.unit}, ${v > m.max ? 'acima' : 'abaixo'} da faixa de ${m.min} a ${m.max} ${m.unit}.`

  return (
    <div className="wines">
      <section className="panel wine-bar">
        <div className="wine-chips">
          {store.wines.map((w) => (
            <button
              key={w.id}
              className={`wine-chip${wine && w.id === wine.id ? ' on' : ''}`}
              onClick={() => setStore((s) => ({ ...s, active: w.id }))}
            >
              {w.name}
            </button>
          ))}
          <button className="ghost" onClick={() => setDialog({ initial: newWine() })}>
            + Novo vinho
          </button>
        </div>
      </section>

      {!wine ? (
        <section className="panel empty">
          <h2>Monitore um vinho específico</h2>
          <p>
            Cadastre um vinho com as condições ideais dele e o painel passa a avaliar a temperatura, a umidade e a luz
            só em relação a essas faixas. Comece escolhendo um tipo:
          </p>
          <div className="presets">
            {Object.keys(PRESETS).map((k) => (
              <button key={k} className="ghost" onClick={() => setDialog({ initial: newWine(k) })}>
                {k}
              </button>
            ))}
            <button className="ghost" onClick={() => setDialog({ initial: newWine('Personalizado') })}>
              Personalizado
            </button>
          </div>
        </section>
      ) : (
        <>
          <section className="panel wine-head">
            <div>
              <h2 className="wine-name">{wine.name}</h2>
              <p className="fw-desc">
                {wine.kind} · {wine.tmin} a {wine.tmax} °C · umidade {wine.hmin} a {wine.hmax} % · luz até {wine.lmax} %
              </p>
              {wine.notes && <p className="wine-notes">{wine.notes}</p>}
            </div>
            <div className="wine-actions">
              <button className="ghost" onClick={() => setDialog({ initial: wine })}>
                Editar
              </button>
              <button className="ghost danger" onClick={remove}>
                Excluir
              </button>
            </div>
          </section>

          <div className={`verdict ${!hasData ? '' : issues.length ? 'bad' : 'ok'}`} role="status">
            {!hasData ? (
              'Aguardando leituras do sensor...'
            ) : issues.length ? (
              <>
                <b>Atenção para {wine.name}</b>
                <ul>
                  {issues.map((r) => (
                    <li key={r.m.key}>{issueText(r)}</li>
                  ))}
                </ul>
              </>
            ) : (
              <b>Condições ideais para {wine.name}.</b>
            )}
          </div>

          <div className="left">
            {metrics.map((m) => (
              <Metric key={m.key} m={m} value={data[m.key]} values={history[m.key]} />
            ))}
          </div>

          <section className="panel">
            <h2>Resumo das últimas leituras</h2>
            <div className="table-wrap">
              <table className="stats">
                <thead>
                  <tr>
                    <th>Parâmetro</th>
                    <th>Faixa do vinho</th>
                    <th>Mínimo</th>
                    <th>Média</th>
                    <th>Máximo</th>
                    <th>Na faixa</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.map((m) => {
                    const s = stats(history[m.key], m)
                    return (
                      <tr key={m.key}>
                        <td>{m.name}</td>
                        <td>{m.key === 'l' ? `até ${m.max} %` : `${m.min} a ${m.max} ${m.unit}`}</td>
                        <td>{s ? fmt(s.min, m.dec) : '—'}</td>
                        <td>{s ? fmt(s.avg, m.dec) : '—'}</td>
                        <td>{s ? fmt(s.max, m.dec) : '—'}</td>
                        <td>{s ? `${s.ok} %` : '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <p className="hint">
              O resumo usa as leituras recebidas nesta sessão (até 40 por sensor). Os alertas sonoros e os LEDs do ESP32
              usam as faixas do vinho selecionado, enviadas ao escolher ou editar o vinho.
            </p>
          </section>
        </>
      )}

      {dialog && <WineDialog key={dialog.initial.id ?? 'novo'} initial={dialog.initial} onSave={save} onClose={() => setDialog(null)} />}
    </div>
  )
}