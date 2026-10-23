// Todas as requisições da coleção "FIWARE Descomplicado" que o front-end precisa,
// já adaptadas ao dispositivo lamp200. As URLs passam pelo proxy do Vite:
//   /iota -> IoT Agent (4041)   /orion -> Orion (1026)   /sth -> STH-Comet (8666)

export const ENTITY_TYPE = 'Lamp'

export const GROUPS = [
  { id: 'check', title: 'Verificação', desc: 'Confira se os serviços do servidor estão respondendo.' },
  { id: 'setup', title: 'Configuração inicial', desc: 'Rode em ordem, uma única vez, ou use o botão "Configurar tudo".' },
  { id: 'query', title: 'Consultas', desc: 'Veja o que já está cadastrado e os dados guardados.' },
  { id: 'cmd', title: 'Comandos de teste', desc: 'Enviam um comando ao ESP32 e mostram a resposta completa do servidor. Úteis para descobrir a causa de um erro.' },
  { id: 'clean', title: 'Limpeza', desc: 'Apagam dados no servidor. Use com cuidado.' },
]

export function buildActions(cfg) {
  const { host, entity } = cfg
  const deviceId = `lamp${entity.split(':').pop()}`
  const ent = `/orion/v2/entities/${entity}`

  const device = {
    devices: [
      {
        device_id: deviceId,
        entity_name: entity,
        entity_type: ENTITY_TYPE,
        protocol: 'PDI-IoTA-UltraLight',
        transport: 'MQTT',
        commands: [
          { name: 'on', type: 'command' },
          { name: 'off', type: 'command' },
          { name: 'alert_on', type: 'command' },
          { name: 'alert_off', type: 'command' },
          { name: 'wine', type: 'command' },
        ],
        attributes: [
          { object_id: 's', name: 'state', type: 'Text' },
          { object_id: 'l', name: 'luminosity', type: 'Integer' },
          { object_id: 't', name: 'temperature', type: 'Float' },
          { object_id: 'h', name: 'humidity', type: 'Float' },
          { object_id: 'a', name: 'alert', type: 'Text' },
          { object_id: 'at', name: 'alertTemperature', type: 'Text' },
          { object_id: 'ah', name: 'alertHumidity', type: 'Text' },
          { object_id: 'al', name: 'alertLuminosity', type: 'Text' },
          { object_id: 'ar', name: 'armed', type: 'Text' },
        ],
      },
    ],
  }

  return [
    // ---------- verificação ----------
    { id: 'iota-health', group: 'check', method: 'GET', title: 'IoT Agent', desc: 'Health check do IoT Agent (porta 4041).', url: '/iota/iot/about' },
    { id: 'orion-version', group: 'check', method: 'GET', title: 'Orion Context Broker', desc: 'Versão do Orion (porta 1026).', url: '/orion/version' },
    { id: 'sth-version', group: 'check', method: 'GET', title: 'STH-Comet', desc: 'Versão do STH-Comet (porta 8666).', url: '/sth/version' },

    // ---------- configuração inicial (ordem importa) ----------
    {
      id: 'service-group', group: 'setup', setup: true, method: 'POST',
      title: '1. Criar Service Group',
      desc: 'Cria o grupo de serviço com a apikey TEF.',
      url: '/iota/iot/services',
      body: { services: [{ apikey: 'TEF', cbroker: `http://${host}:1026`, entity_type: 'Thing', resource: '' }] },
    },
    {
      id: 'device', group: 'setup', setup: true, method: 'POST',
      title: `2. Cadastrar dispositivo ${deviceId}`,
      desc: 'Cria o dispositivo com os atributos e comandos usados pelo ESP32.',
      url: '/iota/iot/devices',
      body: device,
    },
    {
      id: 'registration', group: 'setup', setup: true, method: 'POST',
      title: '3. Registrar comandos no Orion',
      desc: 'Permite enviar on, off, alert_on, alert_off e wine pelo Orion.',
      url: '/orion/v2/registrations',
      body: {
        description: `${deviceId} Commands`,
        dataProvided: {
          entities: [{ id: entity, type: ENTITY_TYPE }],
          attrs: ['on', 'off', 'alert_on', 'alert_off', 'wine'],
        },
        provider: { http: { url: `http://${host}:4041` }, legacyForwarding: false },
      },
    },
    {
      id: 'subscription', group: 'setup', setup: true, method: 'POST',
      title: '4. Assinar o STH-Comet',
      desc: 'Guarda o histórico de temperatura, umidade e luminosidade. Rodar de novo cria uma assinatura duplicada.',
      url: '/orion/v2/subscriptions',
      body: {
        description: 'Historico de temperatura, umidade e luminosidade',
        subject: {
          entities: [{ id: entity, type: ENTITY_TYPE }],
          condition: { attrs: ['temperature', 'humidity', 'luminosity'] },
        },
        notification: {
          http: { url: `http://${host}:8666/notify` },
          attrs: ['temperature', 'humidity', 'luminosity'],
          attrsFormat: 'legacy',
        },
      },
    },

    // ---------- consultas ----------
    { id: 'entity', group: 'query', method: 'GET', title: 'Valores atuais da entidade', desc: 'Tudo o que o Orion guarda sobre o dispositivo agora.', url: `${ent}?options=keyValues` },
    { id: 'list-devices', group: 'query', method: 'GET', title: 'Dispositivos cadastrados', desc: 'Lista os dispositivos do IoT Agent.', url: '/iota/iot/devices' },
    { id: 'list-services', group: 'query', method: 'GET', title: 'Service Groups', desc: 'Lista os grupos de serviço.', url: '/iota/iot/services' },
    { id: 'list-registrations', group: 'query', method: 'GET', title: 'Registros de comandos', desc: 'Lista os registros do Orion.', url: '/orion/v2/registrations' },
    { id: 'list-subscriptions', group: 'query', method: 'GET', title: 'Assinaturas', desc: 'Lista as assinaturas do Orion (inclui a do STH-Comet).', url: '/orion/v2/subscriptions' },
    { id: 'history', group: 'query', method: 'GET', title: 'Histórico de temperatura', desc: 'Últimas 30 leituras guardadas no STH-Comet.', url: `/sth/STH/v1/contextEntities/type/${ENTITY_TYPE}/id/${entity}/attributes/temperature?lastN=30` },

    // ---------- comandos de teste ----------
    ...['on', 'off', 'alert_on', 'alert_off'].map((c) => ({
      id: `cmd-${c}`, group: 'cmd', method: 'PATCH', title: `Enviar comando ${c}`,
      desc: 'Mesma requisição que o painel faz ao acionar o controle.',
      url: `${ent}/attrs?type=${ENTITY_TYPE}`,
      body: { [c]: { type: 'command', value: '' } },
    })),
    {
      id: 'cmd-iota', group: 'cmd', method: 'POST', title: 'Enviar alert_on direto ao IoT Agent',
      desc: 'Pula o Orion e fala com o IoT Agent. Mostra se o problema está no Orion ou no dispositivo.',
      url: '/iota/v2/op/update',
      body: {
        actionType: 'update',
        entities: [{ id: entity, type: ENTITY_TYPE, alert_on: { type: 'command', value: '' } }],
      },
    },
    {
      id: 'cmd-wine', group: 'cmd', method: 'PATCH', title: 'Enviar comando wine',
      desc: 'Envia um vinho de teste (nome e faixas).',
      url: `${ent}/attrs?type=${ENTITY_TYPE}`,
      body: { wine: { type: 'command', value: 'Teste,10,18,60,80,30' } },
    },

    // ---------- limpeza ----------
    { id: 'del-device', group: 'clean', danger: true, method: 'DELETE', title: `Apagar dispositivo ${deviceId}`, desc: 'Remove o dispositivo do IoT Agent.', url: `/iota/iot/devices/${deviceId}` },
    { id: 'del-entity', group: 'clean', danger: true, method: 'DELETE', title: 'Apagar entidade no Orion', desc: 'Remove a entidade e os valores atuais.', url: ent },
    { id: 'del-service', group: 'clean', danger: true, method: 'DELETE', title: 'Apagar Service Group', desc: 'Remove o grupo de serviço da apikey TEF.', url: '/iota/iot/services/?resource=&apikey=TEF' },
  ]
}

// Executa uma ação e devolve { ok, status, ms, body, note }
export async function run(action, cfg) {
  const headers = {
    Accept: 'application/json',
    'fiware-service': cfg.service,
    'fiware-servicepath': '/',
  }
  if (action.body) headers['Content-Type'] = 'application/json'

  const t0 = performance.now()
  try {
    const res = await fetch(action.url, {
      method: action.method,
      headers,
      body: action.body ? JSON.stringify(action.body) : undefined,
    })
    const text = await res.text()
    let body = text
    let data = null
    try {
      data = JSON.parse(text)
      body = JSON.stringify(data, null, 2)
    } catch {
      /* resposta que não é JSON (ex.: vazia) */
    }
    return {
      ok: res.ok,
      status: res.status,
      ms: Math.round(performance.now() - t0),
      body: body || '(sem conteúdo)',
      data,
      note: res.status === 409 ? 'Já existe' : '',
    }
  } catch (e) {
    return {
      ok: false,
      status: 0,
      ms: Math.round(performance.now() - t0),
      body: `Não foi possível alcançar o servidor.\n${e.message}`,
      note: '',
    }
  }
}

export const deviceIdOf = (entity) => `lamp${entity.split(':').pop()}`

// Comandos que o registro do Orion precisa ter
const COMMANDS = ['on', 'off', 'alert_on', 'alert_off', 'wine']

// Apaga os registros de comandos desta entidade e cria um novo, completo e com o IP atual
export async function recreateRegistration(cfg) {
  const list = await run({ method: 'GET', url: '/orion/v2/registrations' }, cfg)
  if (!list.ok) return list
  for (const r of Array.isArray(list.data) ? list.data : []) {
    if (r.dataProvided?.entities?.some((e) => e.id === cfg.entity)) {
      await run({ method: 'DELETE', url: `/orion/v2/registrations/${r.id}` }, cfg)
    }
  }
  return run(buildActions(cfg).find((a) => a.id === 'registration'), cfg)
}

// Recria o dispositivo no IoT Agent e o registro de comandos no Orion.
// Os valores e o histórico guardados continuam no servidor.
// Devolve { ok, text, body }
export async function recreateCommands(cfg) {
  const acts = buildActions(cfg)
  const get = (id) => acts.find((a) => a.id === id)

  const group = await run(get('service-group'), cfg)
  if (!group.ok && group.status !== 409) {
    return { ok: false, text: `Não deu para criar o grupo de serviço (erro ${group.status || 'de conexão'}).`, body: group.body }
  }

  await run({ method: 'DELETE', url: `/iota/iot/devices/${deviceIdOf(cfg.entity)}` }, cfg)
  const device = await run(get('device'), cfg)
  if (!device.ok && device.status !== 409) {
    return { ok: false, text: `Não deu para cadastrar o dispositivo (erro ${device.status || 'de conexão'}).`, body: device.body }
  }

  const reg = await recreateRegistration(cfg)
  if (!reg.ok && reg.status !== 409) {
    return { ok: false, text: `Não deu para registrar os comandos (erro ${reg.status || 'de conexão'}).`, body: reg.body }
  }
  return { ok: true }
}

// Descobre o que já está pronto no servidor.
// true = já existe, false = falta criar, null = não deu para saber (servidor sem resposta)
export async function checkStatus(cfg) {
  const get = (url) => run({ method: 'GET', url }, cfg)
  const [iota, orion, sth, groups, device, regs, subs] = await Promise.all([
    get('/iota/iot/about'),
    get('/orion/version'),
    get('/sth/version'),
    get('/iota/iot/services'),
    get(`/iota/iot/devices/${deviceIdOf(cfg.entity)}`),
    get('/orion/v2/registrations'),
    get('/orion/v2/subscriptions'),
  ])

  const list = (r) => (Array.isArray(r.data) ? r.data : [])

  return {
    servers: { iota: iota.ok, orion: orion.ok, sth: sth.ok },
    steps: {
      'service-group': groups.ok ? (groups.data?.services ?? []).some((s) => s.apikey === 'TEF') : null,
      device: device.ok ? true : device.status === 404 ? false : null,
      registration: regs.ok
        ? list(regs).some(
            (r) =>
              r.dataProvided?.entities?.some((e) => e.id === cfg.entity) &&
              COMMANDS.every((c) => r.dataProvided?.attrs?.includes(c)) &&
              r.provider?.http?.url?.includes(cfg.host) &&
              r.provider?.legacyForwarding === false,
          )
        : null,
      subscription: subs.ok
        ? list(subs).some(
            (s) =>
              s.subject?.entities?.some((e) => e.id === cfg.entity) &&
              s.notification?.http?.url?.includes(':8666'),
          )
        : null,
    },
  }
}