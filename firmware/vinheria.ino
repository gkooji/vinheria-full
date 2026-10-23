// =====================================================================================
//  ADEGA MONITOR - Monitoramento de vinheria com ESP32, MQTT e FIWARE
// =====================================================================================
//
// Equipe:
//   Guilherme Kooji Kubota ............... RM 570541
//   Victor da Silva Souto ................ RM 571093
//   Luis Carlos Pageu Domingues .......... RM 569214
//   João Paulo Francisco de Oliveira ..... RM 571306
//   Eduardo Menzel ....................... RM 570405
//
// Base do firmware: sketch original de Fábio Henrique Cabrini, adaptado pela equipe.
//
// Resumo:
//   Monitoramento de vinheria via MQTT/FIWARE. O ESP32 publica o estado do LED, a luminosidade
//   (LDR), a temperatura e a umidade (DHT11/DHT22). O sistema de alertas é armado e desarmado
//   remotamente pelo front-end. As leituras e o estado dos alertas aparecem em um LCD 16x2 I2C.
//   Um botão (GPIO 4) navega entre as telas do LCD: leituras, vinho, faixas, alertas e rede.
//
// Como o sistema funciona (visão geral):
//   1. A cada 3 s o ESP32 lê os sensores e publica os valores no broker MQTT.
//   2. O IoT Agent converte as mensagens MQTT e grava os dados no Orion (entidade Lamp:200).
//   3. O painel web lê o Orion e envia comandos de volta (ligar LED, armar alerta, escolher vinho).
//   4. O Orion repassa o comando ao IoT Agent, que o publica no tópico /TEF/lamp200/cmd.
//   5. O ESP32 recebe o comando na função mqtt_callback() e age sobre ele.
//
// LED azul = LED onboard do ESP32 (GPIO 2), sem componente externo.
//
// Comandos aceitos em /TEF/lamp200/cmd:
//   lamp200@on|         liga o LED azul (onboard)      lamp200@off|        desliga o LED azul
//   lamp200@alert_on|   ARMA o sistema de alertas      lamp200@alert_off|  DESARMA (para LED azul e buzzer)
//   lamp200@wine|NOME,tmin,tmax,hmin,hmax,lmax   define o vinho monitorado e as faixas dele
//                       (o nome aparece no LCD ao apertar o botão)
//
// Bibliotecas: PubSubClient, DHT sensor library (Adafruit) / "DHT sensor library for ESPx" no Wokwi,
//              LiquidCrystal I2C (Frank de Brabander)
// =====================================================================================

#include <WiFi.h>                 // conexão WiFi do ESP32
#include <PubSubClient.h>         // cliente MQTT
#include <DHT.h>                  // sensor de temperatura e umidade (DHT11/DHT22)
#include <Wire.h>                 // barramento I2C (usado pelo LCD)
#include <LiquidCrystal_I2C.h>    // LCD 16x2 com módulo I2C

// ===================== Simulação x hardware real =====================
// O Wokwi só simula o DHT22. No hardware real do projeto usamos o DHT11.
// O DHT11 e o DHT22 enviam os dados em formatos diferentes: se o tipo configurado aqui não
// corresponder ao sensor ligado, as leituras vêm erradas ou aparece "Falha na leitura".
#define SIMULACAO_WOKWI 0   // 1 = Wokwi (DHT22), 0 = hardware real (DHT11)

#if SIMULACAO_WOKWI
  #define DHTTYPE DHT22
#else
  #define DHTTYPE DHT11
#endif

// ===================== Configurações editáveis =====================
// Rede WiFi. No Wokwi use "Wokwi-GUEST" sem senha. No ESP32 físico use a sua rede de 2,4 GHz
// (o ESP32 não conecta em redes de 5 GHz).
const char* default_SSID = "Wokwi-GUEST";
const char* default_PASSWORD = "";

// IP público da instância AWS onde roda o broker MQTT. Sem Elastic IP ele muda quando a
// instância é parada e iniciada, então confira este valor sempre que religar o servidor.
const char* default_BROKER_MQTT = "32.192.26.155";
const int   default_BROKER_PORT = 1883;                   // porta padrão do MQTT

const char* default_TOPICO_SUBSCRIBE = "/TEF/lamp200/cmd"; // tópico onde chegam os comandos
const char* default_ID_MQTT = "fiware_200";               // identificador deste cliente no broker
const char* topicPrefix = "lamp200";                      // prefixo das mensagens de comando

// Tópicos de publicação (o IoT Agent mapeia cada sufixo para um atributo no Orion)
const char* TOPICO_ESTADO = "/TEF/lamp200/attrs";     // s|on / s|off
const char* TOPICO_LUM    = "/TEF/lamp200/attrs/l";   // luminosidade (%)
const char* TOPICO_TEMP   = "/TEF/lamp200/attrs/t";   // temperatura (°C)
const char* TOPICO_UMID   = "/TEF/lamp200/attrs/h";   // umidade (%)
const char* TOPICO_ALERTA = "/TEF/lamp200/attrs/a";   // alerta geral (0/1)
const char* TOPICO_A_TEMP = "/TEF/lamp200/attrs/at";  // anomalia de temperatura (0/1)
const char* TOPICO_A_UMID = "/TEF/lamp200/attrs/ah";  // anomalia de umidade (0/1)
const char* TOPICO_A_LUM  = "/TEF/lamp200/attrs/al";  // anomalia de luminosidade (0/1)
const char* TOPICO_ARMADO = "/TEF/lamp200/attrs/ar";  // sistema de alertas armado (0/1)

// ===================== Pinos =====================
const int PIN_LED_AZUL     = 2;   // LED azul ONBOARD do ESP32 (sem LED externo)
const int PIN_LED_AMARELO  = 25;  // luminosidade
const int PIN_LED_VERMELHO = 26;  // temperatura
const int PIN_LED_VERDE    = 27;  // umidade
const int PIN_BUZZER       = 18;  // buzzer passivo (precisa ser passivo para gerar tons diferentes)
const int PIN_LDR          = 34;  // entrada analógica do sensor de luz
const int PIN_DHT          = 15;  // dados do DHT11/DHT22
const int PIN_BOTAO        = 4;   // botão (entre o GPIO 4 e o GND, usa pull-up interno)
const int PIN_LCD_SDA      = 21;  // LCD I2C
const int PIN_LCD_SCL      = 22;  // LCD I2C

// ===================== LCD =====================
// Endereço I2C: 0x27 (Wokwi e maioria dos módulos). Alguns módulos usam 0x3F.
// Se o LCD ficar em branco no hardware real, teste o outro endereço e ajuste o contraste
// no potenciômetro azul do módulo.
LiquidCrystal_I2C lcd(0x27, 16, 2);

// ===================== Triggers (faixas ideais para vinhos) =====================
// Valores padrão. Quando o painel seleciona um vinho, ele envia as faixas desse vinho
// (comando wine) e estas variáveis passam a valer para LEDs, buzzer e LCD.
// São variáveis (e não constantes) justamente para poderem ser trocadas em tempo de execução.
float TEMP_MIN = 10.0;  // °C
float TEMP_MAX = 18.0;  // °C
float UMID_MIN = 60.0;  // %
float UMID_MAX = 80.0;  // %
int   LUM_MAX  = 30;    // %

// ===================== Sons de alerta (frequência + ritmo distintos) =====================
// Cada tipo de problema tem um som próprio, para dar para identificar de ouvido o que saiu da faixa.
const int FREQ_TEMP = 1000;   // 1 tom longo
const int FREQ_UMID = 1800;   // 2 bipes curtos
const int FREQ_LUZ  = 2600;   // 3 bipes rápidos
const unsigned long FRASE_MS = 1200;  // duração de cada "frase" sonora

// ===================== Intervalos (ms) =====================
// O código não usa delay() no loop principal: cada tarefa compara millis() com o instante
// da última execução. Assim o LED, o buzzer e o botão respondem sem travar uns aos outros.
const unsigned long INTERVALO_ESTADO   = 5000;  // reenvio do estado do LED azul
const unsigned long INTERVALO_SENSORES = 3000;  // leitura dos sensores
const unsigned long INTERVALO_PISCA    = 300;   // pisca do LED azul em alerta
const unsigned long TELA_MS            = 8000;  // sem apertar o botão, o LCD volta às leituras
const unsigned long DEBOUNCE_MS        = 200;   // anti-repique do botão

// ===================== Variáveis =====================
// Cópias editáveis das configurações acima (as funções da biblioteca pedem char* sem const).
char* SSID = const_cast<char*>(default_SSID);
char* PASSWORD = const_cast<char*>(default_PASSWORD);
char* BROKER_MQTT = const_cast<char*>(default_BROKER_MQTT);
int BROKER_PORT = default_BROKER_PORT;
char* TOPICO_SUBSCRIBE = const_cast<char*>(default_TOPICO_SUBSCRIBE);
char* ID_MQTT = const_cast<char*>(default_ID_MQTT);

WiFiClient espClient;             // conexão TCP usada pelo MQTT
PubSubClient MQTT(espClient);     // cliente MQTT
DHT dht(PIN_DHT, DHTTYPE);        // sensor de temperatura e umidade

// Índices do vetor de anomalias (um item por parâmetro monitorado)
enum { ANOM_TEMP = 0, ANOM_UMID = 1, ANOM_LUZ = 2 };

char EstadoSaida = '0';                 // comando on/off do LED azul
bool alertaArmado = false;              // definido pelo front-end (alert_on / alert_off)
bool anomalia[3] = { false, false, false };  // true quando o parâmetro está fora da faixa
bool alertaAtivo = false;               // armado E com alguma anomalia

bool azulPisca = false;                 // estado atual do pisca do LED azul
int  anomaliaAtual = 0;                 // anomalia cujo som está tocando agora
int  freqAtual = 0;                     // frequência que o buzzer está emitindo (0 = silêncio)
// Instantes (em ms) da última execução de cada tarefa periódica
unsigned long tUltimoEstado = 0, tUltimoSensor = 0, tUltimoPisca = 0, tFrase = 0;

// Vinho monitorado (enviado pelo painel) e controle do botão
String vinhoAtual = "";                 // nome do vinho selecionado no painel
int  paginaLCD = 0;                     // 0 leituras, 1 vinho, 2 faixas, 3 alertas, 4 rede
const int NUM_PAGINAS = 5;              // quantidade de telas do LCD
bool botaoAnterior = HIGH;              // estado anterior do botão (HIGH = solto, pull-up)
unsigned long tBotao = 0, tPagina = 0;  // último aperto e última troca de tela

// Últimas leituras (usadas pelo LCD)
float ultimaTemp = NAN;                 // NAN = ainda sem leitura válida
float ultimaUmid = NAN;
int   ultimaLum  = 0;

// ===================== Buzzer (compatível com ESP32 core 2.x e 3.x) =====================
// A API do PWM (ledc) mudou entre as versões 2.x e 3.x do core do ESP32.
// ESP_ARDUINO_VERSION_MAJOR escolhe a forma certa na hora de compilar.
void buzzerInit() {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
    ledcAttach(PIN_BUZZER, 2000, 8);
#else
    ledcSetup(0, 2000, 8);
    ledcAttachPin(PIN_BUZZER, 0);
#endif
}

// Toca a frequência pedida; freq = 0 silencia o buzzer.
void buzzerTone(int freq) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
    ledcWriteTone(PIN_BUZZER, freq);
#else
    ledcWriteTone(0, freq);
#endif
}

// ===================== LCD =====================
// Inicia o barramento I2C e mostra a tela de boas-vindas.
void initLCD() {
    Wire.begin(PIN_LCD_SDA, PIN_LCD_SCL);
    lcd.init();
    lcd.backlight();
    lcd.clear();
    lcd.setCursor(0, 0);
    lcd.print("Vinheria Monitor");
    lcd.setCursor(0, 1);
    lcd.print("Iniciando...");
}

// Mostra duas linhas de texto apagando a tela antes.
// Usada só para mensagens de conexão (WiFi e MQTT), que aparecem poucas vezes.
void lcdMensagem(const char* l1, const char* l2) {
    lcd.clear();
    lcd.setCursor(0, 0);
    lcd.print(l1);
    lcd.setCursor(0, 1);
    lcd.print(l2);
}

// Telas do LCD (o botão avança uma por vez e volta às leituras depois de TELA_MS):
//   0 Leituras: temperatura e umidade / luminosidade + estado (ou anomalias em alerta)
//   1 Vinho:    nome do vinho monitorado
//   2 Faixas:   faixas ideais do vinho (temperatura, umidade e luz)
//   3 Alertas:  armado/desarmado e parâmetros fora da faixa
//   4 Rede:     WiFi, MQTT e IP
void atualizaLCD() {
    // O LCD tem 16 colunas; o 17º caractere é o terminador de texto.
    char linha1[17];
    char linha2[17];

    switch (paginaLCD) {
        case 1:  // vinho
            snprintf(linha1, sizeof(linha1), "Monitorando:");
            snprintf(linha2, sizeof(linha2), "%s",
                     vinhoAtual.length() ? vinhoAtual.c_str() : "(nenhum)");
            break;

        case 2:  // faixas do vinho
            snprintf(linha1, sizeof(linha1), "T%g-%gC U%.0f-%.0f%%",
                     TEMP_MIN, TEMP_MAX, UMID_MIN, UMID_MAX);
            snprintf(linha2, sizeof(linha2), "Luz maxima: %d%%", LUM_MAX);
            break;

        case 3:  // alertas
            snprintf(linha1, sizeof(linha1), "Alerta:%s",
                     alertaArmado ? "ARMADO" : "DESARMADO");
            if (anomalia[ANOM_TEMP] || anomalia[ANOM_UMID] || anomalia[ANOM_LUZ]) {
                // T = temperatura, U = umidade, L = luz
                snprintf(linha2, sizeof(linha2), "Fora: %s%s%s",
                         anomalia[ANOM_TEMP] ? "T " : "",
                         anomalia[ANOM_UMID] ? "U " : "",
                         anomalia[ANOM_LUZ]  ? "L"  : "");
            } else {
                snprintf(linha2, sizeof(linha2), "Tudo na faixa");
            }
            break;

        case 4:  // rede
            snprintf(linha1, sizeof(linha1), "WiFi:%s MQTT:%s",
                     WiFi.status() == WL_CONNECTED ? "OK" : "X",
                     MQTT.connected() ? "OK" : "X");
            snprintf(linha2, sizeof(linha2), "%s", WiFi.localIP().toString().c_str());
            break;

        default:  // 0: leituras
            if (isnan(ultimaTemp) || isnan(ultimaUmid)) {
                snprintf(linha1, sizeof(linha1), "T:--.-C  U:--%%");
            } else {
                snprintf(linha1, sizeof(linha1), "T:%.1fC U:%.0f%%", ultimaTemp, ultimaUmid);
            }

            if (alertaAtivo) {
                snprintf(linha2, sizeof(linha2), "!ALERTA: %s%s%s",
                         anomalia[ANOM_TEMP] ? "T " : "",
                         anomalia[ANOM_UMID] ? "U " : "",
                         anomalia[ANOM_LUZ]  ? "L"  : "");
            } else {
                snprintf(linha2, sizeof(linha2), "L:%d%% %s", ultimaLum,
                         alertaArmado ? "ARMADO" : "DESARMADO");
            }
            break;
    }

    // Completa com espaços para apagar sobras sem precisar de lcd.clear() (evita piscar)
    lcd.setCursor(0, 0);
    lcd.print(linha1);
    for (int i = strlen(linha1); i < 16; i++) lcd.print(' ');
    lcd.setCursor(0, 1);
    lcd.print(linha2);
    for (int i = strlen(linha2); i < 16; i++) lcd.print(' ');
}

// ===================== Inicialização =====================
void initSerial() { Serial.begin(115200); }   // Monitor Serial a 115200 baud

void initWiFi() {
    delay(10);
    Serial.println("------Conexao WI-FI------");
    Serial.print("Conectando-se na rede: ");
    Serial.println(SSID);
    lcdMensagem("Conectando WiFi", SSID);
    reconectWiFi();
}

// Define o broker e a função que trata as mensagens recebidas.
void initMQTT() {
    MQTT.setServer(BROKER_MQTT, BROKER_PORT);
    MQTT.setCallback(mqtt_callback);
}

// Configura os pinos de saída e faz um teste visual dos LEDs ao ligar.
void InitOutput() {
    pinMode(PIN_LED_AZUL, OUTPUT);
    pinMode(PIN_LED_AMARELO, OUTPUT);
    pinMode(PIN_LED_VERMELHO, OUTPUT);
    pinMode(PIN_LED_VERDE, OUTPUT);
    pinMode(PIN_BOTAO, INPUT_PULLUP);   // pull-up interno: botão solto = HIGH, apertado = LOW
    buzzerInit();
    buzzerTone(0);

    // Teste de inicialização: pisca todos os LEDs
    for (int i = 0; i < 6; i++) {
        bool v = (i % 2 == 0);
        digitalWrite(PIN_LED_AZUL, v);
        digitalWrite(PIN_LED_AMARELO, v);
        digitalWrite(PIN_LED_VERMELHO, v);
        digitalWrite(PIN_LED_VERDE, v);
        delay(200);
    }
}

void setup() {
    InitOutput();
    initSerial();
    initLCD();
    dht.begin();
    analogReadResolution(12);   // leitura do LDR de 0 a 4095
    initWiFi();
    initMQTT();
    delay(2000);                // dá tempo de ler a mensagem de conexão no LCD
    atualizaLCD();
}

void loop() {
    // Mantém WiFi e MQTT conectados (bloqueia até reconectar, se cair)
    VerificaConexoesWiFIEMQTT();
    unsigned long agora = millis();

    // Tarefas periódicas, controladas por tempo (sem delay)
    if (agora - tUltimoEstado >= INTERVALO_ESTADO) {
        tUltimoEstado = agora;
        EnviaEstadoOutputMQTT();
    }
    if (agora - tUltimoSensor >= INTERVALO_SENSORES) {
        tUltimoSensor = agora;
        handleSensores();
    }

    // Tarefas rápidas, executadas a cada volta do loop
    verificaBotao(agora);
    atualizaLedAzul(agora);
    atualizaBuzzer(agora);
    MQTT.loop();   // processa as mensagens recebidas do broker
}

// ===================== Conexões =====================
// Conecta no WiFi e espera até conseguir. Se já estiver conectado, não faz nada.
void reconectWiFi() {
    if (WiFi.status() == WL_CONNECTED) return;
    WiFi.begin(SSID, PASSWORD);
    while (WiFi.status() != WL_CONNECTED) {
        delay(100);
        Serial.print(".");
    }
    Serial.println();
    Serial.print("Conectado com sucesso na rede ");
    Serial.println(SSID);
    Serial.print("IP obtido: ");
    Serial.println(WiFi.localIP());
    lcdMensagem("WiFi conectado!", WiFi.localIP().toString().c_str());
}

void VerificaConexoesWiFIEMQTT() {
    reconectWiFi();
    if (!MQTT.connected()) reconnectMQTT();
}

// Tenta conectar no broker até conseguir. Ao conectar, assina o tópico de comandos
// e republica o estado atual para o painel não ficar com informação velha.
void reconnectMQTT() {
    while (!MQTT.connected()) {
        Serial.print("* Tentando se conectar ao Broker MQTT: ");
        Serial.println(BROKER_MQTT);
        lcdMensagem("Conectando MQTT", BROKER_MQTT);
        if (MQTT.connect(ID_MQTT)) {
            Serial.println("Conectado com sucesso ao broker MQTT!");
            MQTT.subscribe(TOPICO_SUBSCRIBE);
            EnviaEstadoOutputMQTT();
            publicaAlertas();
            atualizaLCD();
        } else {
            Serial.println("Falha ao reconectar no broker. Nova tentativa em 2s");
            lcdMensagem("Falha no MQTT", "Tentando de novo");
            delay(2000);
        }
    }
}

// ===================== MQTT =====================
// Chamada automaticamente a cada mensagem recebida no tópico de comandos.
// O IoT Agent envia no formato  lamp200@comando|valor
void mqtt_callback(char* topic, byte* payload, unsigned int length) {
    // Monta a mensagem como texto
    String msg;
    for (unsigned int i = 0; i < length; i++) msg += (char)payload[i];
    Serial.print("- Mensagem recebida: ");
    Serial.println(msg);

    String p = String(topicPrefix);

    // Publica o estado na hora, para o painel não ler o valor antigo e desfazer o interruptor
    if (msg.equals(p + "@on|"))  { EstadoSaida = '1'; EnviaEstadoOutputMQTT(); }
    if (msg.equals(p + "@off|")) { EstadoSaida = '0'; EnviaEstadoOutputMQTT(); }

    // Ativação/desativação do sistema de alertas pelo front-end
    if (msg.equals(p + "@alert_on|")) {
        alertaArmado = true;
        Serial.println("*** Sistema de alertas ARMADO pelo front-end ***");
        avaliaAlertaAtivo();
        publicaAlertas();
    }
    if (msg.equals(p + "@alert_off|")) {
        alertaArmado = false;
        Serial.println("*** Sistema de alertas DESARMADO pelo front-end ***");
        avaliaAlertaAtivo();
        publicaAlertas();
    }

    // Vinho selecionado no painel: lamp200@wine|NOME,tmin,tmax,hmin,hmax,lmax
    String prefixoVinho = p + "@wine|";
    if (msg.startsWith(prefixoVinho)) {
        aplicaVinho(msg.substring(prefixoVinho.length()));
        Serial.print("Vinho ativo: ");
        Serial.println(vinhoAtual);
        Serial.printf("Faixas: %.1f a %.1f C | %.0f a %.0f %% | luz ate %d %%\n",
                      TEMP_MIN, TEMP_MAX, UMID_MIN, UMID_MAX, LUM_MAX);
        reavaliaFaixas();   // aplica as novas faixas na hora (LEDs, buzzer, LCD e publicação)
    }
}

// Formato do valor: NOME,tmin,tmax,hmin,hmax,lmax  (só o NOME também é aceito)
// Obs.: o Orion rejeita ; < > " ' = ( ) em valores, por isso o separador é a vírgula.
void aplicaVinho(String valor) {
    // Sem vírgula: veio só o nome, as faixas continuam como estavam
    int pv = valor.indexOf(',');
    if (pv < 0) {
        vinhoAtual = valor;
        vinhoAtual.trim();
        return;
    }
    vinhoAtual = valor.substring(0, pv);
    vinhoAtual.trim();

    // Lê os cinco números que vêm depois do nome, separados por vírgula
    float v[5];   // tmin, tmax, hmin, hmax, lmax
    int n = 0;
    int ini = pv + 1;
    while (n < 5) {
        int fim = valor.indexOf(',', ini);
        String parte = (fim < 0) ? valor.substring(ini) : valor.substring(ini, fim);
        v[n++] = parte.toFloat();
        if (fim < 0) break;
        ini = fim + 1;
    }

    // só aceita se vieram as 5 faixas e elas fazem sentido (mínimo menor que o máximo)
    if (n == 5 && v[0] < v[1] && v[2] < v[3]) {
        TEMP_MIN = v[0];
        TEMP_MAX = v[1];
        UMID_MIN = v[2];
        UMID_MAX = v[3];
        LUM_MAX  = (int)v[4];
    }
}

// Recalcula as anomalias com a última leitura e as faixas atuais.
// Usada quando as faixas mudam (novo vinho), sem esperar a próxima leitura dos sensores.
void reavaliaFaixas() {
    anomalia[ANOM_LUZ] = (ultimaLum > LUM_MAX);
    if (!isnan(ultimaTemp) && !isnan(ultimaUmid)) {
        anomalia[ANOM_TEMP] = (ultimaTemp < TEMP_MIN || ultimaTemp > TEMP_MAX);
        anomalia[ANOM_UMID] = (ultimaUmid < UMID_MIN || ultimaUmid > UMID_MAX);
    }
    digitalWrite(PIN_LED_AMARELO,  anomalia[ANOM_LUZ]);
    digitalWrite(PIN_LED_VERMELHO, anomalia[ANOM_TEMP]);
    digitalWrite(PIN_LED_VERDE,    anomalia[ANOM_UMID]);
    avaliaAlertaAtivo();   // também atualiza o LCD
    publicaAlertas();
}

// Publica o estado do LED azul (s|on ou s|off).
void EnviaEstadoOutputMQTT() {
    MQTT.publish(TOPICO_ESTADO, EstadoSaida == '1' ? "s|on" : "s|off");
}

// Publica as anomalias, o alerta geral e se o sistema está armado (0 ou 1).
void publicaAlertas() {
    MQTT.publish(TOPICO_A_TEMP, anomalia[ANOM_TEMP] ? "1" : "0");
    MQTT.publish(TOPICO_A_UMID, anomalia[ANOM_UMID] ? "1" : "0");
    MQTT.publish(TOPICO_A_LUM,  anomalia[ANOM_LUZ]  ? "1" : "0");
    MQTT.publish(TOPICO_ALERTA, alertaAtivo ? "1" : "0");
    MQTT.publish(TOPICO_ARMADO, alertaArmado ? "1" : "0");
}

// ===================== Botão: navega entre as telas do LCD =====================
void verificaBotao(unsigned long agora) {
    bool leitura = digitalRead(PIN_BOTAO);

    // Borda de descida (apertou) com anti-repique: avança para a próxima tela
    if (leitura == LOW && botaoAnterior == HIGH && agora - tBotao > DEBOUNCE_MS) {
        tBotao = agora;
        paginaLCD = (paginaLCD + 1) % NUM_PAGINAS;   // depois da última tela volta à primeira
        tPagina = agora;
        atualizaLCD();
    }
    botaoAnterior = leitura;

    // Volta sozinho às leituras depois de alguns segundos sem apertar
    if (paginaLCD != 0 && agora - tPagina >= TELA_MS) {
        paginaLCD = 0;
        atualizaLCD();
    }
}

// ===================== Sensores e triggers =====================
// Lê os sensores, publica os valores e confere se algum saiu da faixa do vinho.
void handleSensores() {
    // LDR (no módulo do Wokwi o valor sobe com o escuro; se ficar invertido: luminosity = 100 - luminosity)
    int luminosity = map(analogRead(PIN_LDR), 0, 4095, 0, 100);
    float temperatura = dht.readTemperature();
    float umidade = dht.readHumidity();

    ultimaLum = luminosity;

    Serial.print("Luminosidade: "); Serial.print(luminosity); Serial.println(" %");
    MQTT.publish(TOPICO_LUM, String(luminosity).c_str());

    bool mudou = false;   // vira true se alguma anomalia mudou de estado nesta leitura

    bool novaLuz = (luminosity > LUM_MAX);
    if (novaLuz != anomalia[ANOM_LUZ]) { anomalia[ANOM_LUZ] = novaLuz; mudou = true; }

    // O DHT devolve NaN quando a leitura falha; nesse caso não se publica nem se avalia
    if (!isnan(temperatura) && !isnan(umidade)) {
        ultimaTemp = temperatura;
        ultimaUmid = umidade;

        Serial.print("Temperatura: "); Serial.print(temperatura); Serial.println(" C");
        Serial.print("Umidade: "); Serial.print(umidade); Serial.println(" %");
        MQTT.publish(TOPICO_TEMP, String(temperatura, 1).c_str());
        MQTT.publish(TOPICO_UMID, String(umidade, 1).c_str());

        bool novaTemp = (temperatura < TEMP_MIN || temperatura > TEMP_MAX);
        bool novaUmid = (umidade < UMID_MIN || umidade > UMID_MAX);
        if (novaTemp != anomalia[ANOM_TEMP]) { anomalia[ANOM_TEMP] = novaTemp; mudou = true; }
        if (novaUmid != anomalia[ANOM_UMID]) { anomalia[ANOM_UMID] = novaUmid; mudou = true; }
    } else {
        Serial.println("Falha na leitura do sensor DHT!");
    }

    // LEDs indicadores: acendem quando o respectivo parâmetro está fora do trigger
    digitalWrite(PIN_LED_AMARELO,  anomalia[ANOM_LUZ]);
    digitalWrite(PIN_LED_VERMELHO, anomalia[ANOM_TEMP]);
    digitalWrite(PIN_LED_VERDE,    anomalia[ANOM_UMID]);

    // Só reavalia e publica os alertas quando algo mudou, para não inundar o broker
    if (mudou) {
        avaliaAlertaAtivo();
        publicaAlertas();
    }

    atualizaLCD();  // atualiza a cada leitura (3 s)
}

// O alerta só fica ativo quando o sistema está ARMADO e existe pelo menos uma anomalia.
void avaliaAlertaAtivo() {
    bool alguma = anomalia[ANOM_TEMP] || anomalia[ANOM_UMID] || anomalia[ANOM_LUZ];
    alertaAtivo = alertaArmado && alguma;
    if (alertaAtivo) {
        // começa a tocar imediatamente na primeira anomalia ativa
        anomaliaAtual = anomalia[ANOM_TEMP] ? ANOM_TEMP : (anomalia[ANOM_UMID] ? ANOM_UMID : ANOM_LUZ);
        tFrase = millis();
    }
    Serial.println(alertaAtivo ? "!!! ALERTA ATIVO !!!" : "Alerta inativo.");
    atualizaLCD();  // reflete imediatamente armar/desarmar e mudança de alerta
}

// ===================== LED azul: pisca enquanto houver anomalia (se armado) =====================
// Sem alerta, o LED segue o comando on/off do painel. Em alerta, pisca a cada 300 ms
// até todos os valores voltarem à faixa (ou o sistema ser desarmado).
void atualizaLedAzul(unsigned long agora) {
    if (!alertaAtivo) {
        azulPisca = false;
        digitalWrite(PIN_LED_AZUL, EstadoSaida == '1');  // volta ao comando on/off normal
        return;
    }
    if (agora - tUltimoPisca >= INTERVALO_PISCA) {
        tUltimoPisca = agora;
        azulPisca = !azulPisca;
        digitalWrite(PIN_LED_AZUL, azulPisca);
    }
}

// ===================== Buzzer: som diferente para cada tipo de anomalia =====================
// Procura a próxima anomalia ativa depois da atual, para os sons se alternarem
// quando mais de um parâmetro está fora da faixa.
void proximaAnomalia() {
    for (int i = 1; i <= 3; i++) {
        int c = (anomaliaAtual + i) % 3;
        if (anomalia[c]) { anomaliaAtual = c; return; }
    }
}

void atualizaBuzzer(unsigned long agora) {
    // Sem alerta ativo: garante que o buzzer fique em silêncio
    if (!alertaAtivo) {
        if (freqAtual != 0) { buzzerTone(0); freqAtual = 0; }
        return;
    }

    // A cada FRASE_MS passa para a próxima anomalia ativa
    if (agora - tFrase >= FRASE_MS) {
        tFrase = agora;
        proximaAnomalia();   // alterna entre as anomalias ativas
    }

    // t = tempo decorrido dentro da frase atual; define em que ponto do ritmo estamos
    unsigned long t = agora - tFrase;
    int freq = 0;
    if (anomalia[anomaliaAtual]) {
        switch (anomaliaAtual) {
            case ANOM_TEMP:  // 1 tom longo
                if (t < 800) freq = FREQ_TEMP;
                break;
            case ANOM_UMID:  // 2 bipes curtos
                if (t < 200 || (t >= 400 && t < 600)) freq = FREQ_UMID;
                break;
            case ANOM_LUZ:   // 3 bipes rápidos
                if (t < 100 || (t >= 200 && t < 300) || (t >= 400 && t < 500)) freq = FREQ_LUZ;
                break;
        }
    }
    // Só reconfigura o PWM quando a frequência muda
    if (freq != freqAtual) { buzzerTone(freq); freqAtual = freq; }
}
