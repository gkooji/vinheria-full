import { useCallback, useEffect, useMemo, useState } from 'react'
import { GROUPS, buildActions, checkStatus, recreateCommands, recreateRegistration, run } from './fiware'
import './FiwarePanel.css'

const SERVERS = [
  ['iota', 'IoT Agent'],
  ['orion', 'Orion'],
  ['sth', 'STH-Comet'],
]

const STEPS = [
  { id: 'service-group', title: 'Grupo de serviço', desc: 'Libera o dispositivo para enviar dados ao FIWARE.' },
  { id: 'device', title: 'Dispositivo', desc: 'Cadastra os sensores e os comandos da adega.' },
  { id: 'registration', title: 'Comandos remotos', desc: 'Permite ligar o LED e armar o alerta pelo painel.' },
  { id: 'subscription', title: 'Histórico dos gráficos', desc: 'Guarda as leituras para mostrar nos gráficos.' },
]

const STATE_LABEL = { true: ['ok', 'Pronto'], false: ['pend', 'Pendente'], null: ['', 'Sem resposta'] }

// ---------- requisição manual (aba Avançado) ----------
function Action({ a, result, busy, onRun }) {
  return (
    <li className="act">
      <div className="act-head">
        <span className={`method ${a.method}`}>{a.method}</span>
        <div className="act-text">
          <b>{a.title}</b>
          <p>{a.desc}</p>
        </div>
        <button className="ghost" disabled={busy !== null} onClick={() => onRun(a)}>
          {busy === a.id ? 'Executando...' : 'Executar'}
        </button>
      </div>

      <details>
        <summary>Ver requisição</summary>
        <pre>
          {a.method} {a.url}
          {a.body ? '\n\n' + JSON.stringify(a.body, null, 2) : ''}
        </pre>
      </details>

      {result && (
        <div className={`res ${result.ok ? 'ok' : 'bad'}`}>
          <span>
            {result.status || 'Erro'} · {result.ms} ms{result.note ? ` · ${result.note}` : ''}
          </span>
          <pre>{result.body}</pre>
        </div>
      )}
    </li>
  )
}

// ---------- tela ----------
export default function FiwarePanel({ cfg }) {
  const actions = useMemo(() => buildActions(cfg), [cfg])
  const [status, setStatus] = useState(null)
  const [checking, setChecking] = useState(true)
  const [running, setRunning] = useState(false)
  const [msg, setMsg] = useState(null)
  const [results, setResults] = useState({})
  const [busy, setBusy] = useState(null)

  const refresh = useCallback(async () => {
    setChecking(true)
    setStatus(await checkStatus(cfg))
    setChecking(false)
  }, [cfg])

  useEffect(() => {
    refresh()
  }, [refresh])

  const serverOk = status?.servers.iota && status?.servers.orion
  const pending = status ? STEPS.filter((s) => status.steps[s.id] === false) : []
  const allDone = status && STEPS.every((s) => status.steps[s.id] === true)

  const summary = checking
    ? 'Verificando o servidor...'
    : !serverOk
      ? 'Não foi possível falar com o servidor.'
      : allDone
        ? 'Tudo pronto! O dispositivo está configurado.'
        : `${pending.length} ${pending.length === 1 ? 'etapa pendente' : 'etapas pendentes'}.`

  // Cria só o que ainda falta, em ordem
  const configure = async () => {
    setRunning(true)
    setMsg(null)
    for (const s of pending) {
      // o registro de comandos é recriado (apaga o velho) para não ficar duplicado ou desatualizado
      const r = s.id === 'registration' ? await recreateRegistration(cfg) : await run(actions.find((a) => a.id === s.id), cfg)
      if (!r.ok && r.status !== 409) {
        setMsg({ type: 'bad', text: `Não deu para concluir "${s.title}" (erro ${r.status || 'de conexão'}).`, detail: r.body })
        setRunning(false)
        await refresh()
        return
      }
    }
    setMsg({ type: 'ok', text: 'Configuração concluída. Rode o ESP32 e volte ao Painel.' })
    setRunning(false)
    await refresh()
  }

  // Recria o dispositivo e o registro de comandos do zero
  const recreate = async () => {
    if (!window.confirm('Recriar o dispositivo e o registro de comandos?\n\nOs valores e o histórico guardados continuam no servidor.')) return
    setRunning(true)
    setMsg(null)
    const r = await recreateCommands(cfg)
    setMsg(
      r.ok
        ? { type: 'ok', text: 'Dispositivo e comandos recriados. Reinicie o ESP32 e teste os controles no Painel.' }
        : { type: 'bad', text: r.text, detail: r.body },
    )
    setRunning(false)
    await refresh()
  }

  const exec = async (a) => {
    if (a.danger && !window.confirm(`${a.title}?\n\nIsso apaga dados no servidor.`)) return
    setBusy(a.id)
    const r = await run(a, cfg)
    setResults((s) => ({ ...s, [a.id]: r }))
    setBusy(null)
    refresh()
  }

  return (
    <div className="fw">
      <section className="panel">
        <div className="fw-head">
          <div>
            <h2>Servidor</h2>
            <p className="fw-desc">{cfg.host}</p>
          </div>
          <button className="ghost" disabled={checking} onClick={refresh}>
            {checking ? 'Verificando...' : 'Verificar de novo'}
          </button>
        </div>

        <div className="chips">
          {SERVERS.map(([k, name]) => {
            const state = checking || !status ? '' : status.servers[k] ? 'ok' : 'bad'
            return (
              <span key={k} className={`chip ${state}`}>
                <i />
                {name}
              </span>
            )
          })}
        </div>

        {!checking && status && !status.servers.orion && (
          <p className="alert-box">
            O Orion não responde. Na AWS, tente <code>docker restart fiware-orion</code> e verifique de novo.
          </p>
        )}
      </section>

      <section className="panel">
        <h2>Configuração do dispositivo</h2>
        <p className="fw-desc">{summary}</p>

        <ul className="steps">
          {STEPS.map((s, i) => {
            const v = status ? status.steps[s.id] : null
            const [cls, label] = checking ? ['', '...'] : STATE_LABEL[v]
            return (
              <li key={s.id} className={`step ${cls}`}>
                <span className="mark">{v === true && !checking ? '✓' : i + 1}</span>
                <div className="step-text">
                  <b>{s.title}</b>
                  <p>{s.desc}</p>
                </div>
                <span className={`badge ${cls}`}>{label}</span>
              </li>
            )
          })}
        </ul>

        <div className="foot">
          <button className="primary" disabled={running || checking || !serverOk || pending.length === 0} onClick={configure}>
            {running ? 'Configurando...' : allDone ? 'Nada a fazer' : 'Configurar o que falta'}
          </button>
          <button className="ghost" disabled={running || checking || !serverOk} onClick={recreate}>
            Recriar dispositivo e comandos
          </button>
          {msg && (
            <div className={`msg ${msg.type}`}>
              {msg.text}
              {msg.detail && (
                <details>
                  <summary>Ver detalhes</summary>
                  <pre>{msg.detail}</pre>
                </details>
              )}
            </div>
          )}
        </div>
      </section>

      <details className="panel adv">
        <summary>Avançado: requisições manuais</summary>
        {GROUPS.map((g) => (
          <div key={g.id} className="adv-group">
            <h3>{g.title}</h3>
            <p className="fw-desc">{g.desc}</p>
            <ul className="acts">
              {actions
                .filter((a) => a.group === g.id)
                .map((a) => (
                  <Action key={a.id} a={a} result={results[a.id]} busy={busy} onRun={exec} />
                ))}
            </ul>
          </div>
        ))}
      </details>
    </div>
  )
}