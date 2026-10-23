import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import FiwarePanel from './FiwarePanel'
import WinePanel from './WinePanel'
import { Metric } from './Metric'
import './App.css'

const ENTITY_TYPE = 'Lamp'
const POLL_MS = 3000

const METRICS = [
  { key: 't', name: 'Temperatura', unit: '°C', min: 10, max: 18, lo: 0, hi: 35, dec: 1, anomaly: 'at', hero: true },
  { key: 'h', name: 'Umidade', unit: '%', min: 60, max: 80, lo: 20, hi: 100, dec: 0, anomaly: 'ah' },
  { key: 'l', name: 'Luminosidade', unit: '%', min: 0, max: 30, lo: 0, hi: 100, dec: 0, anomaly: 'al' },
]

const ANOMALY_NAMES = { at: 'temperatura', ah: 'umidade', al: 'luminosidade' }

// nome do atributo no Orion -> chave usada na tela
const KEYMAP = {
  temperature: 't',
  humidity: 'h',
  luminosity: 'l',
  state: 's',
  armed: 'ar',
  alert: 'a',
  alertTemperature: 'at',
  alertHumidity: 'ah',
  alertLuminosity: 'al',
}

const HISTORY_ATTRS = { t: 'temperature', h: 'humidity', l: 'luminosity' }

const DEFAULT_CFG = { host: '13.220.167.92', entity: 'urn:ngsi-ld:Lamp:200', service: 'smart' }

function loadCfg() {
  try {
    return { ...DEFAULT_CFG, ...JSON.parse(localStorage.getItem('adegaCfgFiware')) }
  } catch {
    return DEFAULT_CFG
  }
}

// ---------- hook de comunicação com o FIWARE ----------
function useFiware(cfg) {
  const [data, setData] = useState({})
  const [history, setHistory] = useState({ t: [], h: [], l: [] })
  const [status, setStatus] = useState('connecting')
  const [logs, setLogs] = useState([])
  const lastErr = useRef('')
  const prevAlert = useRef(undefined)

  const headers = useMemo(
    () => ({ 'fiware-service': cfg.service, 'fiware-servicepath': '/' }),
    [cfg.service],
  )

  const log = useCallback((text) => {
    const entry = { id: Date.now() + Math.random(), time: new Date().toLocaleTimeString('pt-BR'), text }
    setLogs((l) => [entry, ...l].slice(0, 40))
  }, [])

  // Histórico (STH-Comet)
  const loadHistory = useCallback(
    async (signal) => {
      const out = { t: [], h: [], l: [] }
      await Promise.all(
        Object.entries(HISTORY_ATTRS).map(async ([k, attr]) => {
          try {
            const r = await fetch(
              `/sth/STH/v1/contextEntities/type/${ENTITY_TYPE}/id/${cfg.entity}/attributes/${attr}?lastN=30`,
              { headers, signal },
            )
            if (!r.ok) return
            const j = await r.json()
            const vals = j.contextResponses?.[0]?.contextElement?.attributes?.[0]?.values ?? []
            out[k] = vals.map((v) => parseFloat(v.attrValue)).filter((v) => !Number.isNaN(v))
          } catch {
            /* sem histórico para esse atributo */
          }
        }),
      )
      if (!signal.aborted) setHistory(out)
    },
    [cfg.entity, headers],
  )

  // Valores atuais (Orion)
  const poll = useCallback(
    async (signal) => {
      try {
        const attrs = Object.keys(KEYMAP).join(',')
        const r = await fetch(
          `/orion/v2/entities/${cfg.entity}?type=${ENTITY_TYPE}&options=keyValues&attrs=${attrs}`,
          { headers: { ...headers, Accept: 'application/json' }, signal },
        )
        if (!r.ok) {
          throw new Error(r.status === 404 ? 'Entidade não encontrada no Orion' : `Orion respondeu ${r.status}`)
        }
        const j = await r.json()

        const next = {}
        for (const [attr, key] of Object.entries(KEYMAP)) {
          if (j[attr] !== undefined) next[key] = String(j[attr])
        }
        setData((d) => ({ ...d, ...next }))
        setHistory((h) => {
          const n = { ...h }
          for (const k of ['t', 'h', 'l']) {
            const v = parseFloat(next[k])
            if (!Number.isNaN(v)) n[k] = [...h[k], v].slice(-40)
          }
          return n
        })

        if (next.a !== undefined && prevAlert.current !== undefined && prevAlert.current !== next.a) {
          log(next.a === '1' ? 'Alerta disparado' : 'Alerta encerrado')
        }
        prevAlert.current = next.a

        if (lastErr.current) {
          log('Conectado ao Orion')
          lastErr.current = ''
        }
        setStatus('online')
      } catch (e) {
        if (e.name === 'AbortError') return
        setStatus('offline')
        const msg = e.message === 'Failed to fetch' ? 'Não foi possível alcançar o servidor' : e.message
        if (lastErr.current !== msg) {
          lastErr.current = msg
          log(`Erro: ${msg}`)
        }
      }
    },
    [cfg.entity, headers, log],
  )

  useEffect(() => {
    setStatus('connecting')
    setData({})
    setHistory({ t: [], h: [], l: [] })
    lastErr.current = ''
    prevAlert.current = undefined

    const ctrl = new AbortController()
    let timer
    log(`Consultando ${cfg.entity}`)
    ;(async () => {
      await loadHistory(ctrl.signal)
      await poll(ctrl.signal)
      if (ctrl.signal.aborted) return
      timer = setInterval(() => poll(ctrl.signal), POLL_MS)
    })()

    return () => {
      ctrl.abort()
      clearInterval(timer)
    }
  }, [cfg, loadHistory, poll, log])

  // Envia direto ao IoT Agent (NGSIv2), sem passar pelo registro de comandos do Orion
  const sendViaIota = useCallback(
    async (cmd, value) => {
      const r = await fetch('/iota/v2/op/update', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          actionType: 'update',
          entities: [{ id: cfg.entity, type: ENTITY_TYPE, [cmd]: { type: 'command', value } }],
        }),
      })
      if (!r.ok) {
        const txt = await r.text().catch(() => '')
        let detail = txt.slice(0, 160)
        try {
          const j = JSON.parse(txt)
          detail = j.description || j.error || detail
        } catch {
          /* resposta que não é JSON */
        }
        throw new Error(`IoT Agent respondeu ${r.status}${detail ? ` (${detail})` : ''}`)
      }
    },
    [cfg.entity, headers],
  )

  // Comandos: o Orion repassa ao IoT Agent, que publica em /TEF/lamp200/cmd
  const send = useCallback(
    async (cmd, value = '') => {
      let viaOrion = ''
      try {
        const r = await fetch(`/orion/v2/entities/${cfg.entity}/attrs?type=${ENTITY_TYPE}`, {
          method: 'PATCH',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ [cmd]: { type: 'command', value } }),
        })
        if (r.ok) {
          log(`Comando enviado: ${cmd}`)
          setTimeout(() => poll(), 1500)
          return true
        }
        const txt = await r.text().catch(() => '')
        let detail = txt.slice(0, 160)
        try {
          const j = JSON.parse(txt)
          detail = j.description || j.error || detail
        } catch {
          /* resposta que não é JSON */
        }
        viaOrion = `Orion respondeu ${r.status}${detail ? ` (${detail})` : ''}`
        if (r.status !== 404) {
          log(`Falha ao enviar ${cmd}: ${viaOrion}`)
          return false
        }
      } catch (e) {
        log(`Falha ao enviar ${cmd}: ${e.message}`)
        return false
      }

      // 404: o Orion não encaminhou o comando. Tenta direto no IoT Agent.
      try {
        await sendViaIota(cmd, value)
        log(`Comando enviado: ${cmd} (direto ao IoT Agent)`)
        setTimeout(() => poll(), 1500)
        return true
      } catch (e) {
        log(`Falha ao enviar ${cmd}: ${viaOrion}; ${e.message}`)
        return false
      }
    },
    [cfg.entity, headers, log, poll, sendViaIota],
  )

  return { data, setData, history, status, logs, send }
}

// ---------- componentes ----------
function Switch({ checked, onClick, label }) {
  return <button className="sw" role="switch" aria-checked={checked} aria-label={label} onClick={onClick} />
}

function SettingsDialog({ cfg, onSave, onClose }) {
  const ref = useRef(null)
  const [f, setF] = useState(cfg)

  useEffect(() => {
    ref.current.showModal()
  }, [])

  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))

  const submit = (e) => {
    e.preventDefault()
    onSave({ host: f.host.trim(), entity: f.entity.trim(), service: f.service.trim() })
    ref.current.close()
  }

  return (
    <dialog ref={ref} onClose={onClose}>
      <form onSubmit={submit}>
        <h2>Conexão com o FIWARE</h2>
        <label>
          ID da entidade
          <input type="text" value={f.entity} onChange={set('entity')} required />
        </label>
        <label>
          fiware-service
          <input type="text" value={f.service} onChange={set('service')} required />
        </label>
        <label>
          IP do servidor (AWS)
          <input type="text" value={f.host} onChange={set('host')} required />
        </label>
        <p className="hint">
          Use o mesmo ID e o mesmo serviço do Postman. O IP é usado nos cadastros da aba FIWARE e deve ser o
          mesmo do vite.config.js.
        </p>
        <div className="actions">
          <button type="button" className="ghost" onClick={() => ref.current.close()}>
            Cancelar
          </button>
          <button className="primary">Salvar e conectar</button>
        </div>
      </form>
    </dialog>
  )
}

// ---------- app ----------
export default function App() {
  const [cfg, setCfg] = useState(loadCfg)
  const [showCfg, setShowCfg] = useState(false)
  const [view, setView] = useState('painel')
  const { data, setData, history, status, logs, send } = useFiware(cfg)

  const armed = data.ar === '1'
  const ledOn = data.s === 'on'
  const active = Object.keys(ANOMALY_NAMES).filter((k) => data[k] === '1').map((k) => ANOMALY_NAMES[k])

  const saveCfg = (next) => {
    try {
      localStorage.setItem('adegaCfgFiware', JSON.stringify(next))
    } catch {
      /* armazenamento indisponível */
    }
    setCfg(next)
  }

  const toggleArmed = async () => {
    if (await send(armed ? 'alert_off' : 'alert_on')) setData((d) => ({ ...d, ar: armed ? '0' : '1' }))
  }

  const toggleLed = async () => {
    if (await send(ledOn ? 'off' : 'on')) setData((d) => ({ ...d, s: ledOn ? 'off' : 'on' }))
  }

  const statusText = { online: 'Conectado', offline: 'Desconectado', connecting: 'Conectando...' }[status]

  return (
    <div className="app">
      <header>
        <h1>
          Adega Monitor
          <span>Temperatura, umidade e luz da sua vinheria em tempo real</span>
        </h1>
        <div className="tools">
          <nav className="tabs" aria-label="Seções">
            <button className={view === 'painel' ? 'on' : ''} onClick={() => setView('painel')}>
              Painel
            </button>
            <button className={view === 'vinhos' ? 'on' : ''} onClick={() => setView('vinhos')}>
              Vinhos
            </button>
            <button className={view === 'fiware' ? 'on' : ''} onClick={() => setView('fiware')}>
              FIWARE
            </button>
          </nav>
          <span className={`pill ${status}`}>
            <i />
            {statusText}
          </span>
          <button className="ghost" onClick={() => setShowCfg(true)}>
            Conexão
          </button>
        </div>
      </header>

      {view === 'fiware' ? (
        <FiwarePanel cfg={cfg} />
      ) : view === 'vinhos' ? (
        <WinePanel data={data} history={history} send={send} />
      ) : (
        <>
      {data.a === '1' && (
        <div className="banner" role="alert">
          Alerta ativo: {active.join(', ') || 'verifique os sensores'} fora da faixa ideal.
        </div>
      )}

      <div className="grid">
        <div className="left">
          {METRICS.map((m) => (
            <Metric key={m.key} m={m} value={data[m.key]} flag={data[m.anomaly]} values={history[m.key]} />
          ))}
        </div>

        <aside className="side">
          <section className="panel">
            <h2 className="title">Controles</h2>
            <div className="row">
              <div>
                <b>Sistema de alertas</b>
                <p>
                  {armed
                    ? 'Armado. Buzzer e LED azul avisam quando algo sai da faixa.'
                    : 'Desarmado. As leituras continuam, sem alarme.'}
                </p>
              </div>
              <Switch checked={armed} label="Armar sistema de alertas" onClick={toggleArmed} />
            </div>
            <div className="row">
              <div>
                <b>LED azul</b>
                <p>Liga ou desliga o LED da placa.</p>
              </div>
              <Switch checked={ledOn} label="Ligar LED azul" onClick={toggleLed} />
            </div>
          </section>

          <section className="panel">
            <h2 className="title">Atividade</h2>
            <ul className="log">
              {logs.map((l) => (
                <li key={l.id}>
                  <time>{l.time}</time>
                  {l.text}
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>

        </>
      )}

      {showCfg && <SettingsDialog cfg={cfg} onSave={saveCfg} onClose={() => setShowCfg(false)} />}
    </div>
  )
}