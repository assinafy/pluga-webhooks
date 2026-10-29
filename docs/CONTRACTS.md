# Gestão de contratos (CLM)

Os termos de um contrato pertencem a um documento existente. O documento continua usando o mesmo upload, envio e assinatura; cadastrar termos não cria um documento nem solicita assinatura. Escritas exigem um plano com gestão de contratos. Leituras continuam disponíveis quando esse recurso deixa de fazer parte do plano. OAuth usa `documents:read` para consultar e `documents:write` para gravar, além de `account:read` para a seleção de workspace do cliente.

## Fluxo

1. Faça upload ou crie o documento por modelo e persista seu ID.
2. Use `updateContract` para cadastrar contraparte, valor, vigência e referências ao CRM. Os termos podem ser cadastrados antes ou depois da assinatura.
3. Envie e acompanhe o documento pelo fluxo normal. `has_contract` em Document indica a presença de termos.
4. Inscreva os eventos `document_contract_*` necessários, verifique a assinatura do webhook e consulte `getContract` pelo `object.id`. Atualize o registro de origem por ID.
5. Para registrar um instrumento assinado, crie outro documento e vincule seus termos com `parent_document_id` e `relation_type`. A alteração só é aplicada ao contrato pai quando esse instrumento está `certificated`.
6. Para uma alteração direta, consulte os termos e envie seu `updated_at` com `updateContract`, `renewContract` ou `terminateContract`. Um conflito HTTP 409 exige nova leitura e decisão; não sobrescreva silenciosamente.
7. Reconcilie eventos perdidos com `listContracts`, ordenado por `-updated_at`, até alcançar os registros anteriores ao último sincronismo. Persista o progresso somente depois de processar os registros; releia a fronteira e deduplique por documento/versão para cobrir timestamps iguais.

O processamento horário usa o dia de Brasília. Contratos ativos recebem aviso ao iniciar o prazo de denúncia, alertas a 45 e 30 dias do fim e, no dia seguinte ao vencimento, renovação automática ou expiração. Cada renovação avança `term`. Quando o plano perde o recurso, o processamento pausa; ao retornar, recupera termos e aditivos pendentes, sem enviar alertas cuja janela já passou. O responsável deve ser membro ativo; a API valida vínculo, CPF/CNPJ, estado do contrato e regras de aplicação de aditivos.

## Funções e tipos

Importe de `dist/index.js`. Todas as funções retornam `data` inteiro, preservando propriedades adicionais da API. Nenhuma repete escritas automaticamente.

| Função | Requisição | Retorno |
|---|---|---|
| `listContracts(client, filters?)` | GET `/accounts/ACCOUNT_ID/contracts`, todas as páginas | `DocumentContract[]`, deduplicado por `document_id` |
| `getContract(client, documentId)` | GET `/accounts/ACCOUNT_ID/documents/DOCUMENT_ID/contract` | `DocumentContract` ou `DocumentContractAmendment` |
| `getContractFamily(client, documentId)` | GET no mesmo path com `/related` | Contrato raiz com `amendments`, consultável pelo pai ou pelo instrumento |
| `updateContract(client, documentId, input)` | PUT no path `/contract` | Termos salvos ou vínculo de aditivo |
| `renewContract(client, documentId, input)` | POST no path `/contract/renew` | Contrato no novo período |
| `terminateContract(client, documentId, input?)` | POST no path `/contract/terminate` | Contrato com `status: terminated` |

`ContractInput`, `ContractRenewal`, `ContractTermination` e `ContractFilters` correspondem aos requests abaixo. `DocumentContract` e `DocumentContractAmendment` são os modelos completos de resposta. Contratos usam `document_id`, sem propriedade `id`; para chamadas de baixo nível use `envelope`, não `post`, que exige um recurso criado com `id`.

### Consulta e filtros

GET não envia body. `ContractFilters` contém todos os filtros publicados; `status` é texto separado por vírgulas. `ending_within_days: 0` significa hoje, incluindo ambas as extremidades do intervalo. `sort` aceita `end_date`, `-end_date`, `updated_at` e `-updated_at` (padrão). Datas são `YYYY-MM-DD`.

```js
const rows = await listContracts(client, {
  status: 'active,expired',
  counterparty: 'Empresa de exemplo',
  search: 'Prestação de serviços',
  end_date_from: '2026-11-01',
  end_date_to: '2027-10-31',
  ending_within_days: 30,
  external_system: 'crm',
  external_id: 'DEAL_ID',
  sort: '-updated_at',
  expand: 'document',
});
```

`listContracts` envia esses valores como query e controla `page`/`per-page=50` pelos headers de paginação. `data` na resposta HTTP é uma lista de contratos conforme o modelo abaixo; `expand=document` inclui o Document completo documentado em [API.md](API.md#get_document). Consultas individuais retornam um objeto com resource; itens de lista podem omitir resource, e o cliente preserva essa ausência. `getContract` e `getContractFamily` incluem `amendments` quando fornecido pelo serviço; a lista não precisa incluí-lo.

### Cadastro e edição dos termos

PUT envia somente os atributos que mudam, com pelo menos um atributo. Request completo dos termos de um contrato existente:

```json
{
  "status": "active",
  "counterparty_name": "Empresa de exemplo",
  "counterparty_taxpayer_id": "11.222.333/0001-81",
  "value": 120000.5,
  "currency": "BRL",
  "start_date": "2026-11-01",
  "end_date": "2027-10-31",
  "auto_renew": true,
  "renewal_term_months": 12,
  "notice_period_days": 30,
  "owner_id": "OWNER_ID",
  "metadata": { "crm_stage": "won" },
  "external_references": [{ "system": "crm", "id": "DEAL_ID" }],
  "updated_at": "2026-10-28T12:00:00Z"
}
```

Omita `updated_at` no primeiro cadastro. Depois, copie exatamente o valor da última consulta. `external_references` substitui a lista inteira; `[]` ou null limpa as referências. Os campos anuláveis do tipo `ContractInput` aceitam null para limpar; `status`, `auto_renew`, `relation_type` e `updated_at` seguem os tipos do schema publicado e não aceitam null neste cliente. Omitir um atributo o preserva. Valores têm até duas casas decimais e limite de 9999999999999.99; currency tem três letras. Vigência começa no ano 1000, com fim igual ou posterior ao início. Renovação admite 1–600 meses, aviso 0–3650 dias.

`metadata` admite até 50 chaves de 1–40 letras, dígitos, ponto, `_` ou `-`, com texto de até 500 caracteres por valor. Referências externas admitem até 20 itens; `system` usa esses mesmos caracteres, até 64, e é convertido para minúsculas pela API. `id` tem até 255 caracteres, sem emoji/caracteres de quatro bytes. Pares iguais sem distinguir maiúsculas são deduplicados pelo servidor. A API pode rejeitar outras equivalências do banco. CPF/CNPJ e pertença do responsável são validados pelo serviço.

No cadastro inicial, `status` aceita draft, active, expired ou terminated; expired exige fim no passado e terminated exige fim. Depois, use os endpoints de renovação/encerramento para mudar contratos fechados. Um contrato ativo não volta a draft. Alterar `end_date` avança `term`. Documento cancelado, recusado ou expirado não aceita termos novos; termos existentes continuam editáveis.

Resposta HTTP completa dos termos:

```json
{
  "status": 200,
  "message": "",
  "data": {
    "resource": "document_contract",
    "document_id": "DOCUMENT_ID",
    "status": "active",
    "counterparty_name": "Empresa de exemplo",
    "counterparty_taxpayer_id": "11222333000181",
    "value": 120000.5,
    "currency": "BRL",
    "start_date": "2026-11-01",
    "end_date": "2027-10-31",
    "auto_renew": true,
    "renewal_term_months": 12,
    "notice_period_days": 30,
    "term": 1,
    "owner_id": "OWNER_ID",
    "metadata": { "crm_stage": "won" },
    "external_references": [{ "system": "crm", "id": "DEAL_ID" }],
    "amendments": [],
    "created_at": "2026-10-28T12:00:00Z",
    "updated_at": "2026-10-28T12:00:00Z"
  }
}
```

### Aditivos, renovações e encerramentos assinados

No documento do instrumento, use `updateContract` com este request:

```json
{
  "parent_document_id": "DOCUMENT_ID",
  "relation_type": "amendment",
  "value": 130000,
  "end_date": "2028-06-30"
}
```

`parent_document_id` pode apontar para qualquer documento da família; a API resolve a raiz. `relation_type` é obrigatório no primeiro vínculo. `amendment` pode alterar valor, moeda, datas, renovação, aviso, contraparte e metadata; `renewal` somente end_date e value; `termination` somente end_date. Um PUT posterior mescla os termos de um vínculo pendente; null remove a chave desse conjunto de alterações. Envie o `updated_at` do próprio vínculo para impedir sobrescrita concorrente. `{ "parent_document_id": null }` desfaz um vínculo pendente. Um documento com termos próprios não pode ser aditivo.

Resposta HTTP completa do vínculo:

```json
{
  "status": 200,
  "message": "",
  "data": {
    "resource": "document_contract_amendment",
    "document_id": "AMENDMENT_DOCUMENT_ID",
    "document_name": "Aditivo de exemplo.pdf",
    "parent_document_id": "DOCUMENT_ID",
    "relation_type": "amendment",
    "number": null,
    "status": "pending",
    "document_status": "pending_signature",
    "apply_error": null,
    "currency": "BRL",
    "terms": { "value": 130000, "end_date": "2028-06-30" },
    "changes": {
      "value": { "from": 120000.5, "to": 130000 },
      "end_date": { "from": "2027-10-31", "to": "2028-06-30" },
      "term": { "from": 1, "to": 2 }
    },
    "applied_at": null,
    "created_at": "2026-10-28T12:00:00Z",
    "updated_at": "2026-10-28T12:00:00Z"
  }
}
```

Quando aplicado, status passa a `applied`, number identifica sua posição e applied_at registra o instante. Terms e changes preservam o conjunto de alterações; currency registra a moeda no momento da aplicação. Aditivos aplicados são somente leitura. A API aplica instrumentos pela ordem de certificação; um instrumento bloqueado segura os posteriores. `apply_error` informa a causa. Consulte a família para reconciliar, sem reaplicar mudanças com base só na ordem dos webhooks.

### Renovação direta

Request completo de `renewContract`:

```json
{
  "term": 1,
  "end_date": "2028-10-31",
  "value": 130000,
  "updated_at": "2026-10-28T12:00:00Z"
}
```

Envie `term` atual ou um `end_date` posterior ao atual. Sem end_date, a API usa renewal_term_months (12 quando ausente) até alcançar um fim futuro; term é obrigatório nesse caso. Value omitido mantém o valor; null o limpa. A resposta tem o modelo DocumentContract completo acima, com novo end_date, term incrementado, status active e updated_at atual. Expired pode ser reaberto; terminated não pode ser renovado. Uma repetição com term antigo ou data já alcançada é recusada (400), e updated_at divergente resulta em 409. O cliente não faz replay automático.

### Encerramento direto

Request completo de `terminateContract`:

```json
{
  "reason": "Contrato encerrado conforme acordo.",
  "updated_at": "2026-10-28T12:00:00Z"
}
```

Ambos os campos são opcionais; o padrão é `{}`. Reason aceita texto de até 500 caracteres ou null, fica no evento e tem HTML removido pela API. A resposta tem o modelo DocumentContract completo, com status terminated e updated_at atual; os demais termos permanecem. Os alertas de ciclo de vida param.

## Eventos e recuperação

| Evento | Documento em object.id | Conteúdo de payload |
|---|---|---|
| `document_contract_updated` | Contrato | end_date, changed; user_name quando sujeito é usuário |
| `document_contract_renewal_notice` | Contrato | end_date |
| `document_contract_expiring` | Contrato | end_date, days_before |
| `document_contract_expired` | Contrato | end_date, changed |
| `document_contract_renewed` | Contrato | end_date, changed; user_name quando manual |
| `document_contract_terminated` | Contrato | user_name, reason, end_date, changed |
| `document_contract_amended` | Pai | document_id do instrumento, relation_type, number, changes, end_date, changed; user_name quando manual |
| `document_contract_amendment_updated` | Instrumento | user_name, parent_document_id, relation_type, terms, changed |

Esses eventos usam o [mesmo envelope e assinatura](API.md#webhooks) dos eventos de documento. `normalizeEvent` retorna document_id, estado do documento e chave de deduplicação; não encaminha os termos ou dados pessoais do payload. O estado do documento e o estado do contrato são diferentes: consulte os termos para saber se o contrato está active, expired ou terminated. Alterações automáticas e manuais podem gerar mais de um evento; reserve a chave persistentemente e consulte a versão atual.

Em 400, corrija os campos; 403 pode indicar escopo, workspace ou ausência do recurso no plano; 404 indica ausência do documento/termos; 409 exige reconciliar a versão. Timeout/5xx de escrita tem `outcomeUnknown: true`. Use GET e histórico em `/documents/DOCUMENT_ID/activities` antes de decidir repetir. O cliente mantém mensagens de erro seguras e não expõe o corpo upstream, que pode conter dados privados.
