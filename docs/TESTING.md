# Testes e operação

## Verificações locais

```sh
npm ci
npm run check
npm run contract
npm run test:coverage
```

`check` executa lint/sintaxe, typecheck estrito, build e testes Node.js. A suíte usa transporte simulado e bloqueia acesso real à rede: não cria documentos, modifica endpoints ou envia convites. Os cenários cobrem API key/OAuth, isolamento de workspace/ambiente, todas as ações/listas, geometria collect, Email/WhatsApp/DigitalCertificate, CPF/CNPJ, limites, paginação, redirects, resultados desconhecidos de escrita, PKCE, refresh, revogação, endpoints múltiplos e assinaturas Standard Webhooks.

`contract` lê o OpenAPI público e verifica requests/responses, schemas referenciados, endpoints auxiliares, receitas e autenticação. Também pode receber um arquivo local:

```sh
node scripts/audit-contract.mjs /caminho/openapi.json
```

A cobertura mede os arquivos compilados do cliente. Cobertura alta não comprova entrega de mensagem, funcionamento de hardware A3 ou comportamento de um destino externo.

## Smoke test somente de leitura

Forneça `ASSINAFY_ENVIRONMENT=sandbox` ou `production`, `ASSINAFY_ACCOUNT_ID` e exatamente uma credencial: `ASSINAFY_API_KEY` ou `ASSINAFY_ACCESS_TOKEN`. Opcionalmente informe `ASSINAFY_DOCUMENT_ID`.

```sh
npm run smoke
```

O script lê workspace, inscrição legada, endpoints, catálogo de eventos e listas de documentos, templates e contatos. Com document ID, consulta o documento expandido. Não grava dados, expõe URLs privadas nem imprime registros de clientes. Para OAuth, conceda account:read, documents:read e templates:read.

## Aceitação em sandbox

1. Use workspace e registros exclusivamente de teste.
2. Execute o smoke e confirme acesso ao workspace correto.
3. Crie um contato fictício e confirme o ID retornado; a criação não envia convite.
4. Envie um PDF sem efeito legal por multipart, consulte até metadata_ready e confira páginas/download original.
5. Teste criação por modelo e assignments com os papéis e contatos corretos. Enviar assinatura notifica destinatários: use somente destinatários autorizados. Sem essa autorização, use a suíte local para Email/WhatsApp/certificados.
6. Configure seu próprio endpoint em slot disponível; preserve outros endpoints. Confirme segredo, assinatura do corpo original, timestamp e mensagem inválida rejeitada.
7. Confira delivery history e execução no destino; HTTP 2xx no receptor não prova que a automação terminou.
8. Repita o evento e teste a reserva persistente antes de ativar efeitos duplicáveis.

A1/A3 exigem assinatura na interface do signatário com certificado ICP-Brasil correspondente ao CPF/CNPJ. Um token OAuth ou API key não substitui certificado, senha, extensão Web PKI ou hardware A3. Para validar o documento final, confirme certificated/artefatos e faça validação criptográfica do PAdES quando esse for o requisito do processo.

## Aceitação OAuth

Registre uma aplicação de teste com callback HTTPS. Um Cloudflare Quick Tunnel pode expor apenas o handler de callback em loopback durante o teste. Não exponha arquivos locais, tokens ou um servidor genérico de diretório.

Teste PKCE S256, state/issuer, código de uso único, leitura autenticada e workspace correto. Para refresh, solicite offline_access com autorização do usuário, serialize a renovação e persista o token rotacionado. Revogue a conexão ao concluir e confirme 401 usando o access token revogado. Feche o túnel; sua URL temporária deixa de funcionar e precisa ser substituída por callback estável antes de produção.

## Configuração da Pluga

`node scripts/send-fixture.mjs` envia o evento fictício de `examples/document-ready.json` ao receptor configurado em `.secrets/webhook.json`, formato `{"url":"URL_PRIVADA_DA_PLUGA"}`. Use permissão 0600. Esse script só deve ser executado no fluxo de teste: uma automação ativa pode transformar um evento fictício em efeitos reais. O retorno 2xx comprova apenas recepção.

As execuções de produção de 2026-10-04 estão registradas em [live-acceptance.json](evidence/live-acceptance.json): documento existente/virtual e template/collect terminaram assinados e certificados, com entregas de webhook e downloads. Esse registro histórico não comprova os novos fluxos OAuth nem Email/WhatsApp/A1/A3 atuais. Upload/download nativos na Pluga e armazenamento persistente de deduplicação dependem da configuração do integrador.

## CI e release

GitHub Actions executa os checks em Node.js 22 e 24, valida documentação e o contrato público da API. Nenhum segredo de workspace é necessário no CI. Uma indisponibilidade do OpenAPI impede o check de contrato e deve ser resolvida antes do release.

Atualize package.json/package-lock.json com uma versão minor, execute os checks e crie a tag `vVERSÃO` no commit aprovado. Faça push do commit e da tag, confira o SHA do workflow e aguarde todas as execuções terminarem. Não publique credentials, artefatos locais, AGENTS.md ou CLAUDE.md.
