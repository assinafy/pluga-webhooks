# Parceria Assinafy via Pluga Webhooks

## Canal

A [orientação atual da Pluga](https://pluga.zendesk.com/hc/pt-br/articles/1500003326921-Como-integrar-sua-empresa-%C3%A0-Pluga) direciona integrações via Webhooks para o formulário **[Seja uma ferramenta integrada via Pluga Webhooks](https://tally.so/r/wkG6b6)**. Publicação no catálogo depende da avaliação da Pluga. Não há publicação independente garantida por este repositório.

**Enviado em 2026-10-04.** O formulário exibiu “Formulário enviado” e “Obrigado por completar este formulário!”. A candidatura aguarda avaliação da Pluga; não há aprovação de catálogo ou conector nativo confirmada.

- Conteúdo do envio original, apenas como histórico: `pluga-application.json`. Não reutilizar o contato desse arquivo.
- Recibo: `evidence/pluga-submission-confirmed.png`.
- Contato privado para retornos da equipe Pluga: **`contact@example.com`**.
- Contato para catálogo, tutorial e outros materiais públicos: **`contact@example.com`**.
- Correção aprovada e enviada em 2026-10-04: o envio original usou indevidamente o e-mail pessoal da conta de teste. Como a tela de confirmação não oferece edição, o formulário foi reenviado com aviso explícito de correção da mesma candidatura e distinção entre os contatos privado/público. Conteúdo: `pluga-contact-correction.json`; recibo: `evidence/pluga-contact-correction-confirmed.png`. A recepção foi confirmada, mas a alteração do registro original pela equipe Pluga ainda não.
- Tutorial público: <https://github.com/assinafy/pluga-webhooks>.

Foram enviados dados públicos da Assinafy, propostas de uso, JSON fictício, links do tutorial/logos e o contato. Nenhuma chave de produção, URL privada de webhook, login, documento assinado ou payload pessoal foi incluído.

## Descrição em português

**Assinafy — assinatura eletrônica de documentos**

Conecte a assinatura de documentos aos processos da sua empresa com Assinafy, Pluga Webhooks e HTTP Request. Crie signatários, envie documentos a partir de modelos e acompanhe eventos de assinatura e recusa. Use sua chave de API e o ID do workspace para configurar as automações da sua conta.

As ações acima descrevem o escopo da integração; resultados de aceitação real constam em `TESTING.md` e devem estar completos antes de apresentá-las como homologadas.

## Informações técnicas

| Item | Informação |
|---|---|
| Site | `https://www.assinafy.com.br` |
| Aplicação | `https://app.assinafy.com.br` |
| API | `https://api.assinafy.com.br/v1` |
| Documentação | `https://api.assinafy.com.br/v1/docs` |
| Autenticação | Header `X-Api-Key` por conta do cliente |
| Identificação do workspace | `data[].id` de `GET /accounts` |
| Callback de eventos | URL privada gerada pela Pluga para cada automação |
| Callback OAuth | Não se aplica ao fluxo por API key |
| Logo | `assets/logo.png`, `assets/logo-100.png`, `assets/logo-340x150.svg` |
| Hospedagem adicional | Nenhuma para eventos e ações JSON |

Logos públicos incluídos na candidatura:

- SVG: <https://raw.githubusercontent.com/assinafy/pluga-webhooks/main/assets/assinafy-logo.svg>
- PNG: <https://raw.githubusercontent.com/assinafy/pluga-webhooks/main/assets/assinafy-logo.png>

## Casos de uso propostos na candidatura

1. `document_ready` → consulta autenticada → inserir/atualizar linha correspondente no Google Sheets.
2. `document_ready` → consulta autenticada → atualizar o negócio associado no Pipedrive.
3. `document_ready` → consulta autenticada → mover o card associado no Trello.

As ações finais nesses três destinos foram apresentadas como propostas a configurar/testar, sem alegar testes realizados nessas contas. O envio descreve separadamente os fluxos Assinafy ↔ Pluga que passaram nos testes reais.

## Material apresentado e próximos passos

- Conexão autenticada Pluga → Assinafy: evidência obtida.
- Criar signatário, consultar documento, solicitar assinatura e enviar por modelo: confirmados, incluindo assinatura final e arquivos certificados.
- Entrega de eventos reais Assinafy → Pluga: confirmada para upload, metadata, envio, assinatura individual e conclusão, com consulta autenticada do documento.
- Arrays: validados pelo HTTP Request JSON; a exigência de Premium consta da candidatura e do tutorial.
- Reexecuções: tutorial documenta atualização por ID do documento, reserva persistente/atômica para efeitos duplicáveis e reconciliação antes de repetir POST. Não existe deduplicação persistente automaticamente instalada pela receita; fluxos de escrita comerciais precisam implementar/testar esse controle no produtor/destino.
- Contato: `contact@example.com` para retornos privados da Pluga; `contact@example.com` para divulgação pública. Correção recebida, aguardando confirmação de atualização do registro original. Divulgação conjunta descrita como proposta a combinar, sem promessa de verba ou compartilhamento de bases.
- Próximo passo: resposta da Pluga, eventual adaptação editorial do tutorial e confirmação de publicação. Não foi informada data de publicação.

## Manter o tutorial público

Somente a pasta `public-guide/` é publicada no repositório `assinafy/pluga-webhooks`. O remoto local `publication` aponta para esse repositório; a branch local `main` contém também arquivos internos de teste/submissão e não deve ser enviada a ele.

Após revisar e commitar alterações em `public-guide/`:

```sh
git subtree split --prefix=public-guide -b public-guide
git push publication public-guide:main
```

Verifique os exemplos JSON, links e screenshots antes de publicar. Não inclua IDs de teste, chaves, URLs privadas, screenshots de logs expandidos nem arquivos de `artifacts/` ou `.secrets/`.

O cliente de referência suporta OAuth2 com PKCE, troca, refresh e revogação. A modalidade de conexão da Pluga precisa implementar o ciclo de tokens; receitas de headers não o executam.
