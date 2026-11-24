# Envelopes de documentos

Use os métodos existentes de `AssinafyClient`. Um envelope agrupa documentos; cada documento conserva assignment, status, certificado, artefatos e webhooks. `client.envelope()` lê o envelope HTTP `{status, message, data}` e retorna `{data, headers}`; não cria um envelope de documentos por si só.

## Preparação e envio

1. Selecione o workspace, crie ou reutilize contatos e faça upload dos PDFs. Aguarde `metadata_ready` em todos, sem assignment existente.
2. Defina até 20 documentos e 20 signatários distintos. Cada signatário deve participar de pelo menos um documento. O limite conjunto é 2.000 campos e 100 destinatários de cópia, incluindo documentos adicionados depois.
3. Estime usando o mesmo body da criação. Confira `has_sufficient_resources` e use `total_credits` como `max_total_credits`.
4. Persista uma chave ASCII por envelope pretendido antes de enviar. `client.post(path, body, savedKey)` e `client.envelope('POST', path, {json: body, idempotencyKey: savedKey})` encaminham `Idempotency-Key` somente na criação. A chave pertence ao workspace, é sensível a maiúsculas e não expira. Replay explícito devolve o envelope original e ignora mudanças no body; criação em andamento responde 409; depois da exclusão, não recupera o envelope.
5. Confirme cada documento por GET autenticado após os eventos. `counts` resume os status presentes e é null quando não há documentos; o envelope não possui status próprio. HTTP 200 na criação não garante entrega das notificações: confira `assignment.signers[].notification_history` em cada documento.

```js
const path = await client.accountPath('/envelopes');
const { data: estimate } = await client.envelope('POST', `${path}/estimate-cost`, { json: body });
if (!estimate.has_sufficient_resources) throw new Error('Recursos insuficientes');
const sent = await client.post(path, { ...body, max_total_credits: estimate.total_credits }, savedKey);
const current = await client.get(`${path}/${sent.id}`);
```

Os métodos de baixo nível preservam os campos enviados e retornados; a API valida contatos, workspace, canais, geometria, estado e plano. As quatro ações de `runAction` continuam independentes. Não há retry automático, mesmo com chave. Um resultado de escrita desconhecido exige consulta e reconciliação antes de replay.

## Assinaturas, custos e autenticação

Use `Email`, `Whatsapp`, `DigitalCertificate` ou `IdDocumentFaceMatchBasic`, com exatamente um canal Email/Whatsapp compatível, como em [assinaturas](API.md#verificação-e-notificação). Envelopes não aceitam `step`: todos assinam simultaneamente. Cada signatário com certificado fica sozinho em cada documento seu, sempre `virtual`; biometria exige CPF e verifica a identidade uma vez para o envelope. Uma revisão pendente impede a certificação dos documentos afetados; rejeição da revisão cancela o envelope.

Cada envelope consome uma unidade de documento, notificações e verificações de identidade uma vez por signatário; certificados são cobrados em cada documento assinado. Criação, estimativa e adição exigem o recurso Envelopes do plano. OAuth usa `documents:read` para leitura e `documents:write` para mudanças; API key também é aceita.

`embedded: true` aceita os métodos Email/Whatsapp publicados no request. Requer o recurso Embed e origens cadastradas. `signing_urls[].url` é null; emita uma sessão pelo endpoint do documento/assignment/signatário. O iframe lista os documentos do envelope ainda pendentes para esse signatário. Origens e emissão de sessões usam API key no backend, conforme [Embed](API.md#assinatura-incorporada). O kit não implementa a interface de assinatura.

## Operações

Todos os paths abaixo são relativos a `/v1`. IDs vêm das respostas autenticadas. Requisições GET, DELETE e PUT de cancelamento/reenvio não enviam body. Listas usam `client.list`; estimativas, alterações, cancelamento e reenvio usam `client.envelope`; downloads usam `client.binary`.

| Receita | Método | Path | Comportamento |
|---|---|---|---|
| `estimate_envelope` | POST | `/accounts/{accountId}/envelopes/estimate-cost` | Estima sem criar, cobrar ou notificar. |
| `create_envelope` | POST | `/accounts/{accountId}/envelopes` | Cria e envia um convite por signatário. |
| `list_envelopes` | GET | `/accounts/{accountId}/envelopes` | Filtros search e status open/closed; lista paginada. |
| `get_envelope` | GET | `/accounts/{accountId}/envelopes/{envelopeId}` | Consulta documentos na ordem e seus status. |
| `update_envelope` | PATCH | `/accounts/{accountId}/envelopes/{envelopeId}` | Altera somente campos enviados; document_ids contém todos os documentos uma vez. Não notifica. |
| `add_envelope_document` | POST | `/accounts/{accountId}/envelopes/{envelopeId}/documents` | Adiciona documento pronto para signatários existentes; notifica os participantes e cobra somente certificados. |
| `list_envelope_activities` | GET | `/accounts/{accountId}/envelopes/{envelopeId}/activities` | Histórico paginado, inclusive documentos retirados; sort id ou -id. |
| `download_envelope` | GET | `/accounts/{accountId}/envelopes/{envelopeId}/download/{artifactName}` | ZIP na ordem dos documentos; somente artefatos disponíveis, 404 se nenhum. |
| `remind_envelope_signer` | PUT | `/accounts/{accountId}/envelopes/{envelopeId}/signers/{signerId}/resend` | Reenvia um convite para todo o envelope; pode cobrar e is_sent false indica falha. |
| `remove_envelope_document` | DELETE | `/accounts/{accountId}/envelopes/{envelopeId}/documents/{documentId}` | Retira e cancela um documento aberto, notificando os envolvidos; 404 se já retirado. |
| `cancel_envelope` | PUT | `/accounts/{accountId}/envelopes/{envelopeId}/cancel` | Cancela documentos elegíveis e notifica; preserva os fechados ou já assinados/em certificação. |
| `delete_envelope` | DELETE | `/accounts/{accountId}/envelopes/{envelopeId}` | Exige todos os documentos fechados; exclui o envelope e preserva documentos e certificados. |

Cada página usa os headers de paginação; `client.list` reúne todas dentro do orçamento e recusa inconsistências. A lista de envelopes fornece somente thumbnail em artifacts, sem garantir que já exista; a consulta individual fornece os artefatos disponíveis. Para documentos completos, use `/accounts/ACCOUNT_ID/documents?envelope_id=ENVELOPE_ID`.

HTTP 409 pode indicar teto de créditos, envelope fechado, documento fechado ou tentativa de exclusão com envelope aberto. Cancelar primeiro permite excluir o envelope; depois seus documentos ficam avulsos. Retirar um documento não permite apagar o documento enquanto os demais permanecem abertos, pois seu link pode continuar abrindo o envelope. Downloads de certificated/certificate-page/bundle incluem os documentos certificados; pades inclui somente os que o possuem. Os limites e redirects de `binary` continuam aplicáveis.

## Requests e responses completos

Exemplos fictícios. Substitua IDs e valores; não envie o JSON da resposta como request. Campos opcionais dependem do estado. Os modelos e todas as operações também estão nas [receitas](../recipes/requests.json) e no [contrato](../src/contract.json).

### estimate_envelope

`POST /accounts/{accountId}/envelopes/estimate-cost`

Request:

```json
{
  "name": "Documentos de exemplo",
  "message": "Contrato e anexos de exemplo.",
  "max_total_credits": 1.5,
  "signers": [
    {
      "id": "SIGNER_ID",
      "verification_method": "Email",
      "notification_methods": [
        "Email"
      ],
      "embedded": false
    }
  ],
  "documents": [
    {
      "id": "DOCUMENT_ID",
      "method": "collect",
      "entries": [
        {
          "page_id": "PAGE_ID",
          "fields": [
            {
              "signer_id": "SIGNER_ID",
              "field_id": "FIELD_ID",
              "display_settings": {
                "left": 20,
                "top": 30,
                "width": 100,
                "height": 50,
                "fontSize": 20
              }
            }
          ]
        }
      ],
      "signer_ids": [
        "SIGNER_ID"
      ],
      "expires_at": "2027-12-31T23:59:59Z",
      "copy_receiver_ids": [
        "COPY_RECEIVER_ID"
      ]
    }
  ]
}
```

Resposta HTTP 200:

```json
{
  "status": 200,
  "message": "",
  "data": {
    "documents": 1,
    "credits": 0,
    "needs_extra_document": false,
    "extra_document_cost": 0,
    "total_credits": 0,
    "breakdown": [],
    "document_balance": 10,
    "credit_balance": 10,
    "has_sufficient_resources": true,
    "blocking_reason": null,
    "message": null
  }
}
```

### create_envelope

`POST /accounts/{accountId}/envelopes`

Header: `Idempotency-Key: <PERSISTED_ENVELOPE_KEY>`.

Request:

```json
{
  "name": "Documentos de exemplo",
  "message": "Contrato e anexos de exemplo.",
  "max_total_credits": 1.5,
  "signers": [
    {
      "id": "SIGNER_ID",
      "verification_method": "Email",
      "notification_methods": [
        "Email"
      ],
      "embedded": false
    }
  ],
  "documents": [
    {
      "id": "DOCUMENT_ID",
      "method": "collect",
      "entries": [
        {
          "page_id": "PAGE_ID",
          "fields": [
            {
              "signer_id": "SIGNER_ID",
              "field_id": "FIELD_ID",
              "display_settings": {
                "left": 20,
                "top": 30,
                "width": 100,
                "height": 50,
                "fontSize": 20
              }
            }
          ]
        }
      ],
      "signer_ids": [
        "SIGNER_ID"
      ],
      "expires_at": "2027-12-31T23:59:59Z",
      "copy_receiver_ids": [
        "COPY_RECEIVER_ID"
      ]
    }
  ]
}
```

Resposta HTTP 200:

```json
{
  "status": 200,
  "message": "",
  "data": {
    "resource": "envelope",
    "id": "ENVELOPE_ID",
    "name": "Documentos de exemplo",
    "message": "Contrato e anexos de exemplo.",
    "documents": [
      {
        "id": "DOCUMENT_ID",
        "position": 1,
        "name": "contrato.pdf",
        "status": "pending_signature",
        "artifacts": {
          "original": "https://api.assinafy.com.br/v1/documents/DOCUMENT_ID/download/original",
          "thumbnail": "https://api.assinafy.com.br/v1/documents/DOCUMENT_ID/thumbnail"
        },
        "signers": [
          {
            "id": "SIGNER_ID",
            "full_name": "Signatário de exemplo",
            "email": "signer@example.com",
            "whatsapp_phone_number": null,
            "completed": false,
            "signed_at": null
          }
        ]
      }
    ],
    "counts": {
      "pending_signature": 1
    },
    "signing_urls": [
      {
        "signer_id": "SIGNER_ID",
        "url": "https://app.assinafy.com.br/sign/DOCUMENT_ID?email=signer%40example.com",
        "embedded": false
      }
    ],
    "created_at": "2026-11-24T12:00:00Z"
  }
}
```

### list_envelopes

`GET /accounts/{accountId}/envelopes`

Query: `search=exemplo&status=open`.

Sem request body.

Resposta HTTP 200:

```json
{
  "status": 200,
  "message": "",
  "data": [
    {
      "id": "ENVELOPE_ID",
      "name": "Documentos de exemplo",
      "message": "Contrato e anexos de exemplo.",
      "documents": [
        {
          "id": "DOCUMENT_ID",
          "position": 1,
          "name": "contrato.pdf",
          "status": "pending_signature",
          "artifacts": {
            "thumbnail": "https://api.assinafy.com.br/v1/documents/DOCUMENT_ID/thumbnail"
          },
          "signers": [
            {
              "id": "SIGNER_ID",
              "full_name": "Signatário de exemplo",
              "email": "signer@example.com",
              "whatsapp_phone_number": null,
              "completed": false,
              "signed_at": null
            }
          ]
        }
      ],
      "counts": {
        "pending_signature": 1
      },
      "signing_urls": [
        {
          "signer_id": "SIGNER_ID",
          "url": "https://app.assinafy.com.br/sign/DOCUMENT_ID?email=signer%40example.com",
          "embedded": false
        }
      ],
      "created_at": "2026-11-24T12:00:00Z"
    }
  ]
}
```

### get_envelope

`GET /accounts/{accountId}/envelopes/{envelopeId}`

Sem request body.

Resposta HTTP 200:

```json
{
  "status": 200,
  "message": "",
  "data": {
    "resource": "envelope",
    "id": "ENVELOPE_ID",
    "name": "Documentos de exemplo",
    "message": "Contrato e anexos de exemplo.",
    "documents": [
      {
        "id": "DOCUMENT_ID",
        "position": 1,
        "name": "contrato.pdf",
        "status": "pending_signature",
        "artifacts": {
          "original": "https://api.assinafy.com.br/v1/documents/DOCUMENT_ID/download/original",
          "thumbnail": "https://api.assinafy.com.br/v1/documents/DOCUMENT_ID/thumbnail"
        },
        "signers": [
          {
            "id": "SIGNER_ID",
            "full_name": "Signatário de exemplo",
            "email": "signer@example.com",
            "whatsapp_phone_number": null,
            "completed": false,
            "signed_at": null
          }
        ]
      }
    ],
    "counts": {
      "pending_signature": 1
    },
    "signing_urls": [
      {
        "signer_id": "SIGNER_ID",
        "url": "https://app.assinafy.com.br/sign/DOCUMENT_ID?email=signer%40example.com",
        "embedded": false
      }
    ],
    "created_at": "2026-11-24T12:00:00Z"
  }
}
```

### update_envelope

`PATCH /accounts/{accountId}/envelopes/{envelopeId}`

Request:

```json
{
  "name": "Nome atualizado",
  "message": null,
  "document_ids": [
    "DOCUMENT_ID"
  ]
}
```

Resposta HTTP 200:

```json
{
  "status": 200,
  "message": "",
  "data": {
    "resource": "envelope",
    "id": "ENVELOPE_ID",
    "name": "Nome atualizado",
    "message": null,
    "documents": [
      {
        "id": "DOCUMENT_ID",
        "position": 1,
        "name": "contrato.pdf",
        "status": "pending_signature",
        "artifacts": {
          "original": "https://api.assinafy.com.br/v1/documents/DOCUMENT_ID/download/original",
          "thumbnail": "https://api.assinafy.com.br/v1/documents/DOCUMENT_ID/thumbnail"
        },
        "signers": [
          {
            "id": "SIGNER_ID",
            "full_name": "Signatário de exemplo",
            "email": "signer@example.com",
            "whatsapp_phone_number": null,
            "completed": false,
            "signed_at": null
          }
        ]
      }
    ],
    "counts": {
      "pending_signature": 1
    },
    "signing_urls": [
      {
        "signer_id": "SIGNER_ID",
        "url": "https://app.assinafy.com.br/sign/DOCUMENT_ID?email=signer%40example.com",
        "embedded": false
      }
    ],
    "created_at": "2026-11-24T12:00:00Z"
  }
}
```

### add_envelope_document

`POST /accounts/{accountId}/envelopes/{envelopeId}/documents`

Request:

```json
{
  "id": "ADDITIONAL_DOCUMENT_ID",
  "method": "collect",
  "entries": [
    {
      "page_id": "ADDITIONAL_PAGE_ID",
      "fields": [
        {
          "signer_id": "SIGNER_ID",
          "field_id": "FIELD_ID",
          "display_settings": {
            "left": 20,
            "top": 30,
            "width": 100,
            "height": 50,
            "fontSize": 20
          }
        }
      ]
    }
  ],
  "signer_ids": [
    "SIGNER_ID"
  ],
  "expires_at": "2027-12-31T23:59:59Z",
  "copy_receiver_ids": [
    "COPY_RECEIVER_ID"
  ],
  "max_total_credits": 0
}
```

Resposta HTTP 200:

```json
{
  "status": 200,
  "message": "",
  "data": {
    "resource": "envelope",
    "id": "ENVELOPE_ID",
    "name": "Documentos de exemplo",
    "message": "Contrato e anexos de exemplo.",
    "documents": [
      {
        "id": "DOCUMENT_ID",
        "position": 1,
        "name": "contrato.pdf",
        "status": "pending_signature",
        "artifacts": {
          "original": "https://api.assinafy.com.br/v1/documents/DOCUMENT_ID/download/original",
          "thumbnail": "https://api.assinafy.com.br/v1/documents/DOCUMENT_ID/thumbnail"
        },
        "signers": [
          {
            "id": "SIGNER_ID",
            "full_name": "Signatário de exemplo",
            "email": "signer@example.com",
            "whatsapp_phone_number": null,
            "completed": false,
            "signed_at": null
          }
        ]
      },
      {
        "id": "ADDITIONAL_DOCUMENT_ID",
        "position": 2,
        "name": "contrato.pdf",
        "status": "pending_signature",
        "artifacts": {
          "original": "https://api.assinafy.com.br/v1/documents/ADDITIONAL_DOCUMENT_ID/download/original"
        },
        "signers": [
          {
            "id": "SIGNER_ID",
            "full_name": "Signatário de exemplo",
            "email": "signer@example.com",
            "whatsapp_phone_number": null,
            "completed": false,
            "signed_at": null
          }
        ]
      }
    ],
    "counts": {
      "pending_signature": 2
    },
    "signing_urls": [
      {
        "signer_id": "SIGNER_ID",
        "url": "https://app.assinafy.com.br/sign/DOCUMENT_ID?email=signer%40example.com",
        "embedded": false
      }
    ],
    "created_at": "2026-11-24T12:00:00Z"
  }
}
```

### list_envelope_activities

`GET /accounts/{accountId}/envelopes/{envelopeId}/activities`

Query: `sort=-id`.

Sem request body.

Resposta HTTP 200:

```json
{
  "status": 200,
  "message": "",
  "data": [
    {
      "id": 10001,
      "event": "assignment_created",
      "message": "Solicitação criada pelo usuário de exemplo.",
      "payload": {
        "user_name": "Usuário de exemplo"
      },
      "origin": {
        "ip": "192.0.2.1",
        "user-agent": "Example integration"
      },
      "created_at": "2026-11-24T12:00:00Z",
      "document_id": "DOCUMENT_ID",
      "document_name": "contrato.pdf"
    }
  ]
}
```

### download_envelope

`GET /accounts/{accountId}/envelopes/{envelopeId}/download/{artifactName}`

Sem request body.

Resposta HTTP 200: bytes ZIP (`application/zip`), sem JSON. `artifactName`: original, certificated, certificate-page, pades ou bundle.

### remind_envelope_signer

`PUT /accounts/{accountId}/envelopes/{envelopeId}/signers/{signerId}/resend`

Sem request body.

Resposta HTTP 200:

```json
{
  "status": 200,
  "message": "",
  "data": {
    "is_sent": true,
    "envelope_id": "ENVELOPE_ID",
    "signer_id": "SIGNER_ID"
  }
}
```

### remove_envelope_document

`DELETE /accounts/{accountId}/envelopes/{envelopeId}/documents/{documentId}`

Sem request body.

Resposta HTTP 200:

```json
{
  "status": 200,
  "message": "",
  "data": {
    "resource": "envelope",
    "id": "ENVELOPE_ID",
    "name": "Documentos de exemplo",
    "message": "Contrato e anexos de exemplo.",
    "documents": [
      {
        "id": "DOCUMENT_ID",
        "position": 1,
        "name": "contrato.pdf",
        "status": "pending_signature",
        "artifacts": {
          "original": "https://api.assinafy.com.br/v1/documents/DOCUMENT_ID/download/original",
          "thumbnail": "https://api.assinafy.com.br/v1/documents/DOCUMENT_ID/thumbnail"
        },
        "signers": [
          {
            "id": "SIGNER_ID",
            "full_name": "Signatário de exemplo",
            "email": "signer@example.com",
            "whatsapp_phone_number": null,
            "completed": false,
            "signed_at": null
          }
        ]
      }
    ],
    "counts": {
      "pending_signature": 1
    },
    "signing_urls": [
      {
        "signer_id": "SIGNER_ID",
        "url": "https://app.assinafy.com.br/sign/DOCUMENT_ID?email=signer%40example.com",
        "embedded": false
      }
    ],
    "created_at": "2026-11-24T12:00:00Z"
  }
}
```

### cancel_envelope

`PUT /accounts/{accountId}/envelopes/{envelopeId}/cancel`

Sem request body.

Resposta HTTP 200:

```json
{
  "status": 200,
  "message": "",
  "data": [
    {
      "id": "DOCUMENT_ID",
      "status": "rejected_by_user",
      "cancelled": true
    }
  ]
}
```

### delete_envelope

`DELETE /accounts/{accountId}/envelopes/{envelopeId}`

Sem request body.

Resposta HTTP 200:

```json
{
  "status": 200,
  "message": "",
  "data": []
}
```
