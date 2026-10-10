# Referência do cliente TypeScript

Importe as funções e tipos de `dist/index.js` após `npm run build`. Os endpoints e campos seguem o [OpenAPI Assinafy](https://api.assinafy.com.br/v1/docs/openapi.json). Os modelos JSON abaixo são exemplos fictícios com todos os campos publicados; campos opcionais, relações e artefatos dependem do estado do recurso. Propriedades dinâmicas são preservadas como retornadas pela API.

## Tipos e configuração

| Tipo | Campos |
|---|---|
| `Environment` | `production` ou `sandbox` |
| `Credentials` | `type: api_key`, `apiKey`, `accountId`, `environment?`; ou `type: oauth2`, `accessToken`, `accountId`, `environment?` |
| `Runtime` | `fetch?`, `now?`, `timeoutMs?`, `maxPages?`, `maxDownloadBytes?`, `trustedDownloadOrigins?` |
| `Account` | `id`, `name?` |
| `Resource` | `id` e todos os campos adicionais da API |
| `ActionId` | `create_signer`, `get_document`, `create_document_from_template`, `request_signatures` |
| `ListId` | `documents`, `signers`, `templates`, `fields`, `template_roles`, `editor_fields`, `document_pages` |
| `Subscription` | `url`, `email`, `events`, `is_active`; URL/e-mail podem ser nulos na consulta legada |
| `WebhookEndpointInput` | `url`, `email`, `events`; opcionais `name`, `is_active`, `signing_enabled` |
| `WebhookEndpoint` | Configuração, `id`, `name` nulo ou texto, `created_at`, `updated_at` |
| `OAuthApplication` | `clientId`, `clientSecret?`, `environment?` |
| `OAuthSession` | Aplicação publicável, `redirectUri`, `state`, `codeVerifier`, `issuer`, `url`; o segredo não é copiado para a sessão criada |
| `OAuthTokens` | `access_token`, `token_type: Bearer`, `expires_in`, `scope`, `refresh_token?`, `id_token?` |

O timeout padrão é 30 segundos; aceita 1–120000 ms. `maxPages` tem padrão 20 e aceita 1–1000. JSON é limitado a 8 MiB; downloads a 50 MiB por padrão. `now` retorna milissegundos Unix. Origem confiável é uma origem HTTPS exata, sem path, credenciais, IP literal ou hostname interno. Runtime e lista de origens são copiados e congelados pelo cliente.

## Métodos de AssinafyClient

| Método | Requisição | Retorno e comportamento |
|---|---|---|
| `new AssinafyClient(credentials, runtime?)` | Nenhuma | Seleciona host e header privado; valida configuração e ID do workspace |
| `workspace()` | `GET /accounts?page=N&per-page=50` | `Account` selecionado; coalesce consultas concorrentes e exige acesso ao ID configurado |
| `accountPath(suffix)` | Consulta workspace quando necessário | `/accounts/ACCOUNT_ID` + suffix; use somente suffix definido pela aplicação |
| `get(path, query?)` | GET autenticado, query codificada | `data` do envelope, com tipo genérico escolhido pelo chamador |
| `envelope(method, path, options?)` | GET/POST/PUT/PATCH/DELETE; opções `query`, `json` ou `form` | `{data, headers}`; exige status do envelope igual ao HTTP |
| `post(path, json)` | POST JSON autenticado | Recurso em `data`, com ID válido; use para criações |
| `upload(path, form)` | POST multipart autenticado | Recurso criado em `data`, com ID válido; boundary gerado pelo transporte |
| `list(path, query?)` | GET paginado com 50 registros por página | Lista completa deduplicada por ID; falha se páginas forem inconsistentes ou o orçamento acabar |
| `binary(path)` | GET com negociação de JSON/PDF/ZIP/bytes | `Uint8Array`; rejeita páginas JSON/HTML e redirects não autorizados |

Os paths de recursos aceitos começam com `/accounts`, `/documents` ou `/webhooks`. Não forneça URL completa nem path codificado. Os métodos de baixo nível não aplicam as regras de uma ação específica; `runAction` faz os preflights de documento, contatos, papéis e geometria. Não há replay automático.

### Upload e download

```js
const form = new FormData();
form.set('file', new Blob([pdfBytes], { type: 'application/pdf' }), 'example.pdf');
const created = await client.upload(await client.accountPath('/documents'), form);
const bytes = await client.binary(`/documents/${created.id}/download/original`);
```

A resposta do upload é um Document, inicialmente em processamento. O download retorna os bytes, sem envelope JSON. Escolha o artefato pela disponibilidade em `document.artifacts`: `original`, `certificated`, `certificate-page`, `pades` ou `bundle` em `/documents/DOCUMENT_ID/download/ARTEFATO`; `thumbnail` em `/documents/DOCUMENT_ID/thumbnail`, como JPEG.

## Ações e listas

`runAction(action, client, input?)` retorna o recurso inteiro de `data`. `input` admite `body` e os IDs exigidos pela ação. Rejeita campos desconhecidos, enums inválidos, controles e limites fora do contrato.

| Ação | Input | Endpoint e retorno |
|---|---|---|
| `create_signer` | `body: {full_name, email?, whatsapp_phone_number?, government_id?}` | POST `/accounts/ACCOUNT_ID/signers` → Signer; nome obrigatório; contatos podem ser adicionados antes do envio |
| `get_document` | `document_id`, body omitido ou `{}` | GET `/documents/DOCUMENT_ID?expand=assignment` → Document; verifica ID e workspace |
| `create_document_from_template` | `template_id`, `body` descrito abaixo | POST `/accounts/ACCOUNT_ID/templates/TEMPLATE_ID/documents` → Document; modelo ready, papéis completos, editor fields válidos e contatos acessíveis |
| `request_signatures` | `document_id`, `body` descrito abaixo | POST `/documents/DOCUMENT_ID/assignments` → Assignment; estado válido e nenhum assignment existente |

`loadOptions(list, client, parentId?)` retorna `[{value: "ID", label: "Nome"}]`. Documentos, contatos, modelos e campos consultam a lista do workspace; campos incluem `include_standard=1`. `template_roles` e `editor_fields` exigem template ID e filtram os papéis/placements do modelo; `document_pages` exige document ID e usa o número de página retornado pela API.

`contract` contém os contratos de request/response e schemas usados na validação. `API_URLS` contém os hosts fixos por ambiente. Não altere contratos para adicionar campos; atualize a implementação junto à documentação oficial.

## Webhooks

| Função | Request | Response |
|---|---|---|
| `getSubscription(client)` | GET `/accounts/ACCOUNT_ID/webhooks/subscriptions` | Subscription ou null; consulta o endpoint mais antigo |
| `registerSubscription(client, input)` | Consulta configuração/catalogo, depois PUT no path legado | Subscription; reutiliza configuração idêntica e recusa substituir outra |
| `listWebhookEndpoints(client)` | GET `/accounts/ACCOUNT_ID/webhooks/endpoints` | WebhookEndpoint[] |
| `registerWebhookEndpoint(client, input)` | Consulta catálogo/lista, depois POST `/accounts/ACCOUNT_ID/webhooks/endpoints` | WebhookEndpoint; reutiliza URL idêntica ou preserva endpoints de outras integrações |
| `updateWebhookEndpoint(client, endpointId, input)` | PUT `/accounts/ACCOUNT_ID/webhooks/endpoints/ENDPOINT_ID`; somente campos enviados | WebhookEndpoint atualizado |
| `deleteWebhookEndpoint(client, endpointId)` | DELETE no endpoint selecionado | `void`; envelope HTTP contém `data: []` |
| `getWebhookSecret(client, endpointId, rotate?)` | GET `.../secret`; com `rotate: true`, POST `.../secret/rotate` | String `whsec_...`; API key obrigatória no servidor; HTTP 400 quando a assinatura está desativada |
| `verifyWebhookSignature(rawBody, headers, secret, now?)` | Nenhuma; corpo UTF-8 original e objeto Headers | Promise void se válida; HMAC-SHA256 e janela de ±300 s |
| `normalizeEvent(input, accountId, webhookId?)` | Nenhuma; objeto já autenticado, ID do workspace e header opcional | Evento reduzido descrito abaixo |

Cadastro/atualização de endpoints exigem URL pública HTTPS neste cliente, e-mail e códigos de evento do catálogo. O serviço permite um endpoint gratuito ou até três em planos pagos; a API aplica o limite. `is_active` tem padrão true e `signing_enabled` false. Rotacionar o segredo invalida imediatamente o anterior. Não grave o segredo no payload de evento nem o encaminhe à Pluga.

O helper legado exige `is_active: true` e configuração completa; alteração de configuração existente exige operação explícita no endpoint. Mutações devem ser feitas uma vez no setup, sem repetição em cada documento.

```json
{
  "deduplication_key": "WORKSPACE_ID:MESSAGE_ID",
  "activity_id": 10001,
  "account_id": "WORKSPACE_ID",
  "event": "document_ready",
  "created_at": 1791028800,
  "document_id": "DOCUMENT_ID",
  "status": "certificated"
}
```

Sem `webhookId`, a chave termina no ID da atividade. `document_id` aparece somente para eventos conhecidos de documento, com `object.type: Document`; `status` aparece quando fornecido. Eventos novos são tolerados sem inventar document ID. O helper não autentica mensagens nem implementa deduplicação persistente.

## OAuth2

| Função | Input | Request/response |
|---|---|---|
| `createOAuthAuthorization(application, runtime?)` | OAuthApplication + `redirectUri`, `scopes` | GET discovery do issuer; retorna OAuthSession com URL, state aleatório e PKCE S256 |
| `exchangeOAuthCode(session, callbackUrl, clientSecret?, runtime?)` | Sessão guardada no servidor e URL completa do callback | POST form `/oauth/token` com grant authorization_code; retorna OAuthTokens |
| `refreshOAuthToken(application, refreshToken, runtime?)` | Client emissor e token atual | Discovery + POST form `/oauth/token` com grant refresh_token; retorna novos tokens |
| `revokeOAuthToken(application, token, runtime?)` | Client emissor e access/refresh token | Discovery + POST form `/oauth/revoke`; retorna void com HTTP 200, inclusive sem corpo |

Discovery: produção `https://auth.assinafy.com.br/.well-known/oauth-authorization-server`; sandbox `https://auth-sandbox.assinafy.com.br/.well-known/oauth-authorization-server`. Os helpers verificam issuer e endpoints do ambiente antes de enviar tokens. Callback exige HTTPS, URI cadastrada, state e issuer corretos; query de aplicação é preservada. Não use parâmetros reservados de resposta OAuth na URI cadastrada.

Form de troca de código:

```text
grant_type=authorization_code
client_id=CLIENT_ID
client_secret=CLIENT_SECRET
code=ONE_TIME_CODE
redirect_uri=https://app.example.com/oauth/callback
code_verifier=PKCE_VERIFIER
resource=https://api.assinafy.com.br
```

Omita client_secret em clientes public. A troca usa `application/x-www-form-urlencoded` e valores codificados por URLSearchParams. O código vale 60 segundos e só pode ser usado uma vez. Token response não usa envelope:

```json
{
  "access_token": "ACCESS_TOKEN",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "account:read documents:read",
  "refresh_token": "REFRESH_TOKEN",
  "id_token": null
}
```

`refresh_token` existe quando offline_access foi consentido; `id_token` depende de openid. O cliente não valida ID tokens OIDC. No refresh, envie grant_type=refresh_token, client_id, refresh_token e client_secret apenas para confidential. Na revogação, envie client_id, token e o segredo se aplicável. Tokens rotacionam; serialize refresh por conexão, persista o novo token antes de uso e reconcilie timeouts. Não tente novamente com o token antigo.

## Erros

`IntegrationError` estende Error. Campos: `code: string`, `httpStatus?: number`, `outcomeUnknown: boolean`, `safeToRetry: boolean`, `retryAfterSeconds?: number`. A mensagem é segura para logs resumidos; não inclui upstream bodies.

- `API_ERROR`: status HTTP, sem replay; leituras 429/5xx podem ser repetidas depois do intervalo.
- `MUTATION_OUTCOME_UNKNOWN`: escrita com resposta incerta; confira o workspace antes de replay.
- `OAUTH_OUTCOME_UNKNOWN`: troca possivelmente concluída; não reutilize code/refresh token automaticamente.
- `INVALID_INPUT`, `INVALID_ID`, `INVALID_CREDENTIALS`, `INVALID_RUNTIME`: corrigir configuração/input.
- `WORKSPACE_ACCESS_DENIED`, `SIGNER_NOT_FOUND`, `INVALID_CONTACT`, `INVALID_GOVERNMENT_ID`: corrigir conexão ou contato.
- `TEMPLATE_NOT_READY`, `INVALID_ROLE_MAPPING`, `INVALID_EDITOR_FIELDS`, `DOCUMENT_NOT_READY`, `ALREADY_SENT`, `INVALID_ENTRIES`: corrigir estado ou mapeamento.
- `INVALID_RESPONSE`, `PAGINATION_LIMIT`, `PAGINATION_INCONSISTENT`, `RESPONSE_TOO_LARGE`, `REDIRECT_BLOCKED`, `INVALID_FILE_RESPONSE`, `TRANSPORT_ERROR`: revisar resposta/limites/transporte.
- `INVALID_WEBHOOK_SIGNATURE`, `INVALID_EVENT`, `UNKNOWN_EVENT`, `EXISTING_SUBSCRIPTION`: corrigir receptor/configuração.
- `INVALID_OAUTH_CALLBACK`, `OAUTH_DENIED`, `OAUTH_ERROR`: interromper fluxo e reconectar/corrigir aplicação.

## Payloads completos das ações

O campo `data` é desembrulhado pelo cliente. Exemplos de resposta abaixo incluem o envelope HTTP para configurar modelos da Pluga. IDs, contatos e URLs são fictícios; arrays e objetos livres podem incluir campos adicionais em execução.

### create_signer

`POST /accounts/{accountId}/signers`

Request JSON:

```json
{
  "full_name": "John Dove",
  "email": "signer@example.com",
  "whatsapp_phone_number": "+5548999990000",
  "government_id": "390.533.447-05"
}
```

Response HTTP:

```json
{
  "status": 200,
  "message": "",
  "data": {
    "resource": "signer",
    "id": "62d6ee35c7741ca4006b9e11",
    "full_name": "John Signer",
    "email": "signer@example.com",
    "whatsapp_phone_number": "+5548999990000",
    "government_id": "39053344705",
    "has_accepted_terms": false
  }
}
```

### get_document

`GET /documents/{documentId}`

Response HTTP:

```json
{
  "status": 200,
  "message": "",
  "data": {
    "resource": "document",
    "id": "615601fab04c0a3147bb1246",
    "account_id": "d199996981dbd199996981db",
    "template_id": null,
    "name": "document.pdf",
    "status": "metadata_ready",
    "artifacts": {
      "original": "https://api.assinafy.com.br/v1/documents/doc1/download/original"
    },
    "is_closed": false,
    "signing_url": "https://api.assinafy.com.br/v1/sign/doc1",
    "decline_reason": null,
    "declined_by": {
      "resource": "signer",
      "id": "62d6ee35c7741ca4006b9e11",
      "full_name": "John Signer",
      "email": "signer@example.com",
      "whatsapp_phone_number": "+5548999990000",
      "government_id": "39053344705",
      "has_accepted_terms": false
    },
    "tags": [
      {
        "id": "RESOURCE_ID",
        "name": "EXAMPLE"
      }
    ],
    "assignment": {
      "resource": "assignment",
      "id": "615606ef81d199996981dbce",
      "sender_email": "sender@example.com",
      "method": "virtual",
      "expires_at": null,
      "message": "EXAMPLE",
      "signers": [
        {
          "resource": "signer",
          "id": "62d6ee35c7741ca4006b9e11",
          "full_name": "John Signer",
          "email": "signer@example.com",
          "whatsapp_phone_number": "+5548999990000",
          "government_id": "39053344705",
          "has_accepted_terms": false,
          "verification_method": "Email",
          "notification_methods": [
            "Email"
          ],
          "step": 1,
          "notified": true,
          "completed": true,
          "notification_history": [
            {
              "event": "signature_request",
              "status": "sent",
              "error_code": "EXAMPLE",
              "error_message": "EXAMPLE",
              "sent_at": "2026-07-07T12:00:00Z",
              "failed_at": null
            }
          ]
        }
      ],
      "copy_receivers": [
        {}
      ],
      "items": [
        {
          "id": "RESOURCE_ID",
          "page": {
            "id": "615601faf166d6d1d8e7dc30",
            "number": 1,
            "height": 2100,
            "width": 1275,
            "download_url": "https://api.assinafy.com.br/v1/documents/doc1/pages/1a/download"
          },
          "signer": {},
          "field": {},
          "display_settings": {},
          "value": {},
          "completed": true
        }
      ],
      "summary": {
        "signer_count": 1,
        "completed_count": 1,
        "signers": [
          {}
        ]
      },
      "signing_urls": [
        {
          "signer_id": "SIGNER_ID",
          "url": "https://api.assinafy.com.br/v1/sign/doc1?email=joe@example.com"
        }
      ]
    },
    "pages": [
      {
        "id": "615601faf166d6d1d8e7dc30",
        "number": 1,
        "height": 2100,
        "width": 1275,
        "download_url": "https://api.assinafy.com.br/v1/documents/doc1/pages/1a/download"
      }
    ],
    "created_at": "2026-06-03T03:54:16Z",
    "updated_at": "2026-06-03T03:54:16Z"
  }
}
```

### create_document_from_template

`POST /accounts/{accountId}/templates/{templateId}/documents`

Request JSON:

```json
{
  "signers": [
    {
      "role_id": "ROLE_ID",
      "id": "SIGNER_ID",
      "verification_method": "Email",
      "notification_methods": [
        "Email"
      ],
      "step": 1
    }
  ],
  "editor_fields": [
    {
      "field_id": "EDITOR_FIELD_ID",
      "value": "Field value"
    }
  ],
  "name": "sample-contract-one-page.pdf",
  "message": "Message to the signers",
  "expires_at": "2099-01-01T12:00:00Z",
  "tags": [
    "EXAMPLE"
  ]
}
```

Response HTTP:

```json
{
  "status": 200,
  "message": "",
  "data": {
    "resource": "document",
    "id": "615601fab04c0a3147bb1246",
    "account_id": "d199996981dbd199996981db",
    "template_id": null,
    "name": "document.pdf",
    "status": "metadata_ready",
    "artifacts": {
      "original": "https://api.assinafy.com.br/v1/documents/doc1/download/original"
    },
    "is_closed": false,
    "signing_url": "https://api.assinafy.com.br/v1/sign/doc1",
    "decline_reason": null,
    "declined_by": {
      "resource": "signer",
      "id": "62d6ee35c7741ca4006b9e11",
      "full_name": "John Signer",
      "email": "signer@example.com",
      "whatsapp_phone_number": "+5548999990000",
      "government_id": "39053344705",
      "has_accepted_terms": false
    },
    "tags": [
      {
        "id": "RESOURCE_ID",
        "name": "EXAMPLE"
      }
    ],
    "assignment": {
      "resource": "assignment",
      "id": "615606ef81d199996981dbce",
      "sender_email": "sender@example.com",
      "method": "virtual",
      "expires_at": null,
      "message": "EXAMPLE",
      "signers": [
        {
          "resource": "signer",
          "id": "62d6ee35c7741ca4006b9e11",
          "full_name": "John Signer",
          "email": "signer@example.com",
          "whatsapp_phone_number": "+5548999990000",
          "government_id": "39053344705",
          "has_accepted_terms": false,
          "verification_method": "Email",
          "notification_methods": [
            "Email"
          ],
          "step": 1,
          "notified": true,
          "completed": true,
          "notification_history": [
            {
              "event": "signature_request",
              "status": "sent",
              "error_code": "EXAMPLE",
              "error_message": "EXAMPLE",
              "sent_at": "2026-07-07T12:00:00Z",
              "failed_at": null
            }
          ]
        }
      ],
      "copy_receivers": [
        {}
      ],
      "items": [
        {
          "id": "RESOURCE_ID",
          "page": {
            "id": "615601faf166d6d1d8e7dc30",
            "number": 1,
            "height": 2100,
            "width": 1275,
            "download_url": "https://api.assinafy.com.br/v1/documents/doc1/pages/1a/download"
          },
          "signer": {},
          "field": {},
          "display_settings": {},
          "value": {},
          "completed": true
        }
      ],
      "summary": {
        "signer_count": 1,
        "completed_count": 1,
        "signers": [
          {}
        ]
      },
      "signing_urls": [
        {
          "signer_id": "SIGNER_ID",
          "url": "https://api.assinafy.com.br/v1/sign/doc1?email=joe@example.com"
        }
      ]
    },
    "pages": [
      {
        "id": "615601faf166d6d1d8e7dc30",
        "number": 1,
        "height": 2100,
        "width": 1275,
        "download_url": "https://api.assinafy.com.br/v1/documents/doc1/pages/1a/download"
      }
    ],
    "created_at": "2026-06-03T03:54:16Z",
    "updated_at": "2026-06-03T03:54:16Z"
  }
}
```

### request_signatures

`POST /documents/{documentId}/assignments`

Request JSON:

```json
{
  "method": "collect",
  "signers": [
    {
      "id": "SIGNER_ID",
      "verification_method": "Email",
      "notification_methods": [
        "Email"
      ],
      "step": 1
    }
  ],
  "entries": [
    {
      "page_id": "PAGE_ID",
      "fields": [
        {
          "signer_id": "SIGNER_ID",
          "field_id": "FIELD_ID",
          "display_settings": {
            "left": 69,
            "top": 282,
            "width": 421,
            "height": 45.86,
            "fontFamily": "Arial",
            "fontSize": 22,
            "backgroundColor": "#D5EBFF"
          }
        }
      ]
    }
  ],
  "message": "EXAMPLE",
  "expires_at": "2099-01-01T12:00:00Z",
  "copy_receivers": [
    "COPY_RECEIVER_ID"
  ]
}
```

Response HTTP:

```json
{
  "status": 200,
  "message": "",
  "data": {
    "resource": "assignment",
    "id": "615606ef81d199996981dbce",
    "sender_email": "sender@example.com",
    "method": "virtual",
    "expires_at": null,
    "message": "EXAMPLE",
    "signers": [
      {
        "resource": "signer",
        "id": "62d6ee35c7741ca4006b9e11",
        "full_name": "John Signer",
        "email": "signer@example.com",
        "whatsapp_phone_number": "+5548999990000",
        "government_id": "39053344705",
        "has_accepted_terms": false,
        "verification_method": "Email",
        "notification_methods": [
          "Email"
        ],
        "step": 1,
        "notified": true,
        "completed": true,
        "notification_history": [
          {
            "event": "signature_request",
            "status": "sent",
            "error_code": "EXAMPLE",
            "error_message": "EXAMPLE",
            "sent_at": "2026-07-07T12:00:00Z",
            "failed_at": null
          }
        ]
      }
    ],
    "copy_receivers": [
      {}
    ],
    "items": [
      {
        "id": "RESOURCE_ID",
        "page": {
          "id": "615601faf166d6d1d8e7dc30",
          "number": 1,
          "height": 2100,
          "width": 1275,
          "download_url": "https://api.assinafy.com.br/v1/documents/doc1/pages/1a/download"
        },
        "signer": {},
        "field": {},
        "display_settings": {},
        "value": {},
        "completed": true
      }
    ],
    "summary": {
      "signer_count": 1,
      "completed_count": 1,
      "signers": [
        {}
      ]
    },
    "signing_urls": [
      {
        "signer_id": "SIGNER_ID",
        "url": "https://api.assinafy.com.br/v1/sign/doc1?email=joe@example.com"
      }
    ]
  }
}
```

### Endpoint de webhook

POST `/accounts/ACCOUNT_ID/webhooks/endpoints`. Request JSON:

```json
{
  "url": "https://example.com/webhooks/assinafy",
  "email": "ops@example.com",
  "events": [
    "document_ready",
    "signer_signed_document"
  ],
  "name": "ERP",
  "is_active": true,
  "signing_enabled": true
}
```

Response HTTP:

```json
{
  "status": 200,
  "message": "",
  "data": {
    "id": "65f1c2a9b3e4d5f60718293a4b5c6d7e",
    "name": "ERP",
    "url": "https://example.com/webhooks/assinafy",
    "email": "ops@example.com",
    "events": [
      "document_ready",
      "signer_signed_document"
    ],
    "is_active": true,
    "signing_enabled": true,
    "created_at": "2026-10-01T12:00:00Z",
    "updated_at": "2026-10-01T12:00:00Z"
  }
}
```

A lista de endpoints retorna o mesmo modelo em `data: [...]`. PUT retorna o endpoint completo; DELETE retorna `{ "status": 200, "message": "", "data": [] }`. GET/POST do segredo retorna `{ "status": 200, "message": "", "data": { "secret": "whsec_dGVzdC1rZXk=" } }`.

## Payloads de workspace, consultas e listas

`workspace()` e `accountPath()` usam a consulta abaixo, sem request body. `get()`, `list()` e `envelope('GET', ...)` podem executar a mesma consulta. `list()` percorre os headers `X-Pagination-Page-Count` e deduplica IDs; `workspace()` retorna somente o objeto do ID selecionado.

```http
GET /v1/accounts?page=1&per-page=50 HTTP/1.1
Host: sandbox.assinafy.com.br
Accept: application/json
X-Api-Key: <ASSINAFY_API_KEY>
```

```json
{
  "status": 200,
  "message": "",
  "data": [{
    "resource": "account",
    "id": "ACCOUNT_ID",
    "name": "Workspace de exemplo",
    "primary_color": "aabbcc",
    "secondary_color": "112233",
    "notification_sender_type": "Account",
    "roles": ["owner"],
    "is_delete_allowed": true,
    "created_at": "2026-10-01T12:00:00Z"
  }]
}
```

`post()` envia o JSON descrito pela ação; `upload()` envia o multipart descrito acima e retorna o Document completo exemplificado em `get_document`. `envelope()` admite as mesmas requisições, preservando os headers. `binary()` retorna bytes do PDF/ZIP escolhido, sem payload JSON; uma resposta JSON/HTML é rejeitada em vez de ser tratada como arquivo.

As listas `documents` e `signers` retornam `data: [...]` contendo os modelos completos de `get_document` e `create_signer`. Query comum: `page=1&per-page=50`. Campos usam também `include_standard=1`.

| Lista | Request sem body | Modelo HTTP de cada item |
|---|---|---|
| `documents` | GET `/accounts/ACCOUNT_ID/documents` | Document, conforme get_document |
| `signers` | GET `/accounts/ACCOUNT_ID/signers` | Signer, conforme create_signer |
| `templates` | GET `/accounts/ACCOUNT_ID/templates` | Template abaixo |
| `fields` | GET `/accounts/ACCOUNT_ID/fields?include_standard=1` | Field abaixo |
| `template_roles` | GET de templates; selecionar TEMPLATE_ID | Template.roles, excluindo Editor |
| `editor_fields` | GET de templates; selecionar TEMPLATE_ID | Template.pages[].fields dos papéis Editor, deduplicados por field_id |
| `document_pages` | GET `/documents/DOCUMENT_ID?expand=assignment` | Document.pages, com verificação de workspace |

Todas as variantes de `loadOptions()` retornam a mesma forma pública:

```json
[{ "value": "RESOURCE_ID", "label": "Nome apresentado" }]
```

Template completo do modelo de lista; `default_document_tags` é retornado somente na consulta individual do serviço:

```json
{
  "status": 200,
  "message": "",
  "data": [{
    "resource": "template",
    "id": "TEMPLATE_ID",
    "name": "Modelo de exemplo",
    "document_name": "Contrato de exemplo",
    "message": "Confira antes de assinar.",
    "status": "ready",
    "pages": [{
      "id": "PAGE_ID",
      "number": 1,
      "height": 2100,
      "width": 1275,
      "download_url": "https://sandbox.assinafy.com.br/v1/templates/TEMPLATE_ID/pages/PAGE_ID/download",
      "fields": [{
        "id": "PLACEMENT_ID",
        "field_id": "FIELD_ID",
        "role_id": "ROLE_ID",
        "label": "Assinatura",
        "display_settings": { "left": 69, "top": 282, "width": 421, "height": 45.86, "fontSize": 22 },
        "created_at": "2026-10-01T12:00:00Z",
        "updated_at": "2026-10-01T12:00:00Z"
      }]
    }],
    "roles": [{
      "id": "ROLE_ID",
      "name": "Cliente",
      "assignment_type": "Signer",
      "created_at": "2026-10-01T12:00:00Z",
      "updated_at": "2026-10-01T12:00:00Z"
    }],
    "tags": [{ "id": "TAG_ID", "name": "Exemplo" }],
    "created_at": "2026-10-01T12:00:00Z",
    "updated_at": "2026-10-01T12:00:00Z"
  }]
}
```

Field completo:

```json
{
  "status": 200,
  "message": "",
  "data": [{
    "resource": "field",
    "id": "FIELD_ID",
    "name": "Assinatura",
    "type": "signature",
    "regex": null,
    "is_pre_defined": true,
    "is_active": true,
    "is_required": true,
    "is_standard": true,
    "is_read_only": false,
    "is_visible": true
  }]
}
```

## Payloads dos helpers legados e do catálogo

`getSubscription()` usa GET sem body. `registerSubscription()` envia o objeto abaixo por PUT `/accounts/ACCOUNT_ID/webhooks/subscriptions`, após consultar configuração e catálogo. O endpoint mais antigo é o alvo dessa API.

```json
{
  "url": "https://receiver.example.com/webhooks/assinafy",
  "email": "ops@example.com",
  "events": ["document_ready"],
  "is_active": true
}
```

Resposta HTTP completa; o helper mantém os campos retornados pelo serviço, inclusive `updated_at`, embora o tipo Subscription exponha os quatro campos de configuração:

```json
{
  "status": 200,
  "message": "",
  "data": {
    "url": "https://receiver.example.com/webhooks/assinafy",
    "email": "ops@example.com",
    "events": ["document_ready"],
    "is_active": true,
    "updated_at": "2026-10-01T12:00:00Z"
  }
}
```

Se o serviço retornar `data: null`, `getSubscription()` retorna null. O catálogo consultado na validação usa GET `/webhooks/event-types`, sem body:

```json
{
  "status": 200,
  "message": "",
  "data": [{ "id": "document_ready", "description": "Todos os signatários concluíram a assinatura." }]
}
```

Os schemas completos e os envelopes de cada operação suportada estão em [contract.json](../src/contract.json). Campos livres como display_settings e payload preservam os valores do serviço. Os helpers não convertem objetos livres em um modelo inventado.
