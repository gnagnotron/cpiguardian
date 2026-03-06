# cpiguardian
Portale web per il monitoraggio centralizzato delle interfacce SAP Cloud Platform Integration (CPI) di un cliente specifico.

## Funzionalita
- Dashboard web con metriche principali (interfacce deployate, running, messaggi success/fail).
- Tabella interfacce CPI deployate con filtro per stato.
- Tabella messaggi recenti con filtro per stato (SUCCESS, FAILED, PROCESSING).
- Auto-refresh ogni 30 secondi.
- Backend proxy verso SAP CPI con autenticazione `basic` o `oauth`.

## Requisiti
- Node.js 18+ (necessario per usare `fetch` nativo lato server).
- Accesso alle API runtime del tenant SAP CPI.

## Configurazione
1. Copia `.env.example` in `.env`.
2. Compila almeno i campi seguenti:

```env
CPI_BASE_URL=https://<tenant>-tmn.<region>.hana.ondemand.com/itspaces
CPI_AUTH_TYPE=basic
CPI_USERNAME=<utente>
CPI_PASSWORD=<password>
PORT=3000
CPI_MESSAGES_TOP=100
```

Per autenticazione OAuth:

```env
CPI_AUTH_TYPE=oauth
CPI_TOKEN_URL=<url-token>
CPI_CLIENT_ID=<client-id>
CPI_CLIENT_SECRET=<client-secret>
CPI_OAUTH_SCOPE=<scope-opzionale>
```

## Avvio
```bash
npm install
npm run dev
```

Apri `http://localhost:3000`.

## Endpoint esposti
- `GET /api/health`
- `GET /api/cpi/overview`
- `GET /api/cpi/interfaces?status=Running`
- `GET /api/cpi/messages?status=FAILED&top=50`

## Note SAP CPI
- L'app usa questi endpoint OData lato tenant CPI:
	- `api/v1/IntegrationRuntimeArtifacts`
	- `api/v1/MessageProcessingLogs`
- In base alla versione/tenant CPI i nomi campo possono variare. Nel mapping sono gestiti fallback per i campi piu comuni.
