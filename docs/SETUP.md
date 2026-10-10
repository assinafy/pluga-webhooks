# Configuração na Pluga

## Dados da conexão

| Campo | Valor |
|---|---|
| Aplicação | `https://app.assinafy.com.br` |
| API | `https://api.assinafy.com.br/v1` |
| Autenticação HTTP | Header `X-Api-Key` com a chave da sua conta |
| Workspace | `accountId`: ID do workspace escolhido em `GET /accounts` |
| Tipo de conteúdo | `application/json` para as receitas deste kit |
| Basic Auth | Deixar vazio |

Crie ou selecione uma chave nas configurações da Assinafy. Insira-a apenas no campo de headers da conexão/requisição Pluga. O histórico de execução da Pluga pode exibir o header configurado em texto: restrinja acesso às automações e não compartilhe logs ou screenshots desses campos. Não coloque a chave no endereço, corpo do webhook, modelo de resposta, planilha ou receita compartilhada. O ID do workspace aparece em `data[].id` na resposta de `GET /accounts`; confirme o nome antes de selecioná-lo.

Para a configuração manual por chave, use X-Api-Key. OAuth2 com PKCE e Bearer também está disponível no cliente de referência; a conexão precisa implementar consentimento e renovação. Consulte o fluxo completo no [README](../README.md).

## Pluga → Assinafy

1. Escolha a origem da automação. Para o teste inicial, use **Pluga Webhooks → Notificação recebida**, com dados fictícios.
2. Adicione **HTTP Request → Enviar uma mensagem via HTTP Request** como ação. A ação antiga de Webhooks foi validada para GET e criação de signatário com campos simples; use HTTP Request para corpos com arrays.
3. Use o método e o caminho de `recipes/requests.json`, precedido pela URL da API. Substitua `{accountId}`, `{documentId}` e `{templateId}` pelos IDs selecionados. Esses marcadores são explicativos; não são tags nativas da Pluga.
4. Configure `X-Api-Key` e `Accept: application/json`. Para JSON, configure também `Content-Type: application/json`.
5. Em **Tipo de preenchimento dos campos da requisição**, selecione **Preencher campos com um JSON**. Cole o objeto completo no campo **Corpo da requisição (JSON)** e configure **Cabeçalhos (JSON)** como um objeto contendo `X-Api-Key`, `Accept` e `Content-Type`. Preserve arrays e objetos; `signers` precisa ser uma lista de objetos, não uma string contendo JSON. Confirme o corpo efetivamente enviado no teste do construtor antes de ativar etapas com envio de convites.
6. Quando houver etapas seguintes, informe o `response_model` da receita. No envelope da Assinafy, o ID criado está em **`data.id`**. O histórico da ação Webhooks da Pluga adicionou outro nível `data`; nele o ID aparece em `data.data.id`. Selecione o campo pela estrutura observada no retorno da ação escolhida.
7. Teste e confira o registro em Assinafy e o histórico da automação antes de ativar.

### Criar signatário

`POST /accounts/{accountId}/signers`

| Chave | Tipo | Regra |
|---|---|---|
| `full_name` | texto | Nome completo, obrigatório |
| `email` | texto | E-mail válido |
| `whatsapp_phone_number` | texto | Opcional, formato E.164 como `+5548999990000` |

Informe o contato necessário antes de solicitar assinatura; o cadastro aceita somente o nome. Para testes use e-mail sob seu controle. Criar um signatário não solicita assinatura. E-mail duplicado pode retornar HTTP 400; procure o signatário existente antes de criar novamente.

### Criar documento a partir de modelo

`POST /accounts/{accountId}/templates/{templateId}/documents`

- Selecione um modelo pronto no mesmo workspace (`GET /accounts/{accountId}/templates`).
- Mapeie uma entrada em `signers` para cada papel não-editor: `role_id` do modelo e `id` do signatário existente.
- Para campos do editor, use `editor_fields: [{"field_id":"ID_DO_CAMPO","value":"VALOR"}]`. Remova esse campo se o modelo não tiver campos do editor.
- A receita usa verificação e notificação por `Email`. WhatsApp e certificado digital têm requisitos e possíveis custos próprios.
- `name`, `message`, `expires_at` e `tags` são opcionais. Expiração exige ISO 8601 com fuso, pelo menos uma hora à frente.
- **Esta chamada cria o documento e inicia o fluxo de assinatura.** Use somente destinatários autorizados no teste.

Os IDs ilustrativos em `recipes/requests.json` devem ser substituídos por IDs do workspace. O HTTP Request oferece um corpo JSON completo. A execução real com `signers`, `notification_methods` e `tags` foi aprovada em 2026-10-04, com documento assinado e certificado; veja `TESTING.md`.

### Solicitar assinaturas de documento existente

`POST /documents/{documentId}/assignments`

Leia antes `GET /documents/{documentId}?expand=assignment`. Confirme `data.account_id`, ausência de uma solicitação existente e estado compatível. Use `method: "virtual"` e `signers: [{"id":"ID_DO_SIGNATARIO", "verification_method":"Email", "notification_methods":["Email"]}]`.

O modo `collect` exige campos posicionados em páginas e está validado no cliente de referência. O fluxo inicial usa `virtual`; use corpo JSON completo também para `collect`.

### Consultar documento / listas

Use `GET /documents/{documentId}?expand=assignment` para verificar o estado real e o workspace. Trate URLs de artefatos como endpoints autenticados, não como links públicos prontos para compartilhar.

Para **Nova requisição na API**, listas usam chave de dados `data` e chave única `id`. `page=1&per-page=50` é apenas uma página. Não anuncie leitura de todos os registros sem testar paginação. Deduplicar somente por documento não identifica todas as mudanças de status; prefira notificações recebidas para eventos de assinatura.

## Assinafy → Pluga

1. Crie o gatilho **Pluga Webhooks → Notificação recebida** e use **Conectar nova conta** para gerar sua URL privada.
2. Configure o modelo com `examples/document-ready.json` ou capture um evento real. O exemplo é fictício e não prova uma entrega.
3. Consulte **`GET /accounts/{accountId}/webhooks/subscriptions` antes de mudar qualquer configuração**. O path legado atua no endpoint mais antigo. Para configurar uma integração adicional, consulte GET /accounts/{accountId}/webhooks/endpoints e cadastre por POST uma URL própria; o limite é um endpoint gratuito ou até três nos planos pagos. Preserve os endpoints dos outros integradores.
4. Configure a inscrição pela Assinafy ou pela receita `register_subscription`, uma única vez na instalação. Ela envia `url`, `email`, `events` e `is_active: true`. Escolha os eventos em `GET /webhooks/event-types`. Não inclua essa chamada em cada execução da automação.
5. Filtre `account_id` pelo workspace esperado e `event` pelo evento desejado. Para conclusão de todas as assinaturas, use `document_ready`; para cada assinatura, `signer_signed_document`.
6. No evento de documento, use **`object.id`** como ID do documento. O **`id` superior é o ID da atividade**, não do documento. O objeto de `signer_created` é um signatário, e eventos de modelo trazem um modelo.
7. Consulte novamente o documento na API antes de executar ações que dependam do estado. `document_ready` informa que todos assinaram; o objeto pode refletir `ready` ou já estar `certificated`, como observado no teste real. A entrega do evento por si só não garante que o PDF certificado já esteja disponível. Aguarde confirmação de `certificated`/artefato disponível para baixá-lo.
8. Verifique em `GET /accounts/{accountId}/webhooks` a entrega (`delivered`, `http_status`) e, na Pluga, a execução do passo de destino. Um HTTP 2xx da recepção não demonstra que toda a automação terminou.

O evento real também pode incluir dados pessoais do usuário em `subject` e metadados em `origin`. Não repasse o envelope completo para destinos adicionais; mapeie apenas os campos necessários e preserve a confidencialidade dos logs.

O envelope contém `id`, `event`, `account_id`, `created_at` (Unix em segundos), `subject`, `object`, `payload`, `origin` e `message`. Campos adicionais devem ser tolerados. Um evento pode ser repetido ou chegar fora de ordem. Use `account_id + ":" + id` como chave em armazenamento persistente antes de efeitos duplicáveis; a presença dessa chave no helper não implementa deduplicação na Pluga.

A API suporta Standard Webhooks: habilite signing_enabled no endpoint, obtenha o segredo por API key e verifique corpo original, webhook-id, webhook-timestamp e webhook-signature antes de usar o evento. O cliente inclui verifyWebhookSignature. Se a Pluga não permitir essa verificação, use um receptor seu para verificar antes de encaminhar. Mantenha a URL privada e confirme o objeto por GET autenticado. A API tenta entregar até duas vezes, com três segundos entre tentativas.

## PDF, erros e recuperação

Upload Assinafy exige `multipart/form-data` com arquivo binário; URL e base64 enviados em JSON não substituem o arquivo. O cliente local possui `upload()`/`binary()` para diagnóstico, mas o transporte equivalente dentro da Pluga ainda não foi validado. Não é necessário hospedar um conversor para trabalhar com modelos já existentes.

HTTP 401: confira a chave; 403: permissões/workspace; 400/422: campos; 429: respeite `Retry-After`. Em timeout ou HTTP 5xx após POST/PUT, confira primeiro se o efeito ocorreu. Não reenvie automaticamente uma criação ou convite. O cliente local nunca repete gravações; o comportamento de reexecução da Pluga deve ser confirmado na aceitação.

## Fontes

- [Guia oficial Pluga Webhooks](https://pluga.zendesk.com/hc/pt-br/articles/360007678434-Pluga-Webhooks-Como-criar-automatiza%C3%A7%C3%B5es-com-ferramentas-n%C3%A3o-integradas-%C3%A0-Pluga)
- [Documentação Assinafy](https://api.assinafy.com.br/v1/docs), seções Authentication, Webhooks e Webhook Payloads.
- [Contrato OpenAPI Assinafy](https://api.assinafy.com.br/v1/docs/openapi.json), consultado em 2026-10-09.

- [HTTP Request: corpo e cabeçalhos JSON](https://pluga.co/ferramentas/http-request/integracao/), consultado em 2026-10-04. Recurso Premium; a conta de teste usa o período de experimentação.
