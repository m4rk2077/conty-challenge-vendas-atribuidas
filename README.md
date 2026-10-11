# Conty 05 — Vendas atribuídas ao criador

API local que recebe pedidos e estornos, atribui cada venda a no máximo um criador e mantém um histórico auditável. Um replay não soma novamente. Estorno parcial reduz o valor líquido; estorno integral reverte a atribuição financeira sem apagar o criador nem a decisão original. Estorno anterior ao pedido fica persistido até ele chegar.

Implementação do [desafio Vendas atribuídas ao criador](https://challenge.appconty.com/desafios/vendas-shopify). Não depende de Shopify real. Node 22, TypeScript estrito, Hono, `node:sqlite` e Vitest; dependências fixadas no lockfile.

## Rodar

Use **Node 22.23.3**, indicado em `.nvmrc` (mínimo 22.13.0; o projeto aceita somente a série 22). Confira `node --version` antes de instalar. O SQLite nativo em Node 22 emite um aviso experimental; não exige instalação de driver nem flag adicional.

```sh
npm ci
npm run check
npm run seed
npm start
```

`check` verifica os tipos, compila e executa os testes. `npm test` também compila antes de testar. `seed` usa o código compilado: ao iniciar sem rodar `check`, execute `npm run build` antes de `seed`/`start`.

A API escuta em `http://127.0.0.1:3000`. `GET /health` retorna `{"status":"ok"}`. O esquema é criado automaticamente e de forma idempotente ao abrir o banco; não há migração ou servidor de banco separado para instalar. `seed` cadastra somente os códigos abaixo e pode ser repetido sem duplicá-los.

| Loja | Tipo | Código | Criador |
|---|---|---|---|
| `store_a` | cupom | `LIA20` | `crt_lia` |
| `store_a` | UTM | `creator:crt_bia` | `crt_bia` |
| `store_b` | cupom | `LIA20` | `crt_ana` |

O arquivo padrão é `./data/sales.sqlite`, relativo ao diretório em que o comando é executado. Configure `DB_PATH` e `PORT` se necessário. A pasta pai do banco é criada automaticamente. Os dados não entram no Git.

```powershell
# PowerShell: configuração opcional antes de seed/start
$env:DB_PATH = './data/minha-loja.sqlite'
$env:PORT = '3001'
```

O seed serve à demonstração. Para outros códigos, adapte os registros de `src/seed.ts` e recompile. A configuração local usa `SalesService.putCreatorCode`; não existe endpoint administrativo exposto.

## Decisões

### Atribuição e dinheiro

- Todos os valores são inteiros seguros em centavos; não há operação de ponto flutuante monetário. Pedido aceita total zero; estorno exige valor positivo. Cada loja usa uma única moeda, sem conversão.
- Cupom ativo e cadastrado na loja vence UTM de outro criador. Se ambos resolvem para o mesmo criador, o motivo é `coupon_and_utm_agree`; se somente um resolve, ele vence. Se nenhum resolve, o motivo é `no_matching_creator`, com `creator_id: null` e líquido atribuído zero.
- UTM de atribuição é exclusivamente `utms.content` com token explícito cadastrado `creator:...`. `source`, `campaign` e texto livre não escolhem criador. Códigos são comparados exatamente, inclusive maiúsculas e minúsculas.
- A regra está em uma única função pura, `src/attribution.ts`, com testes. A decisão, total, cupom e UTMs ficam fixos no primeiro recebimento do pedido. Reconfigurar um código não transfere vendas antigas.
- Um total/cupom/UTM diferente para o mesmo pedido é conflito `409`, inclusive quando o total proposto fica abaixo do que já foi estornado. O valor aceito e os estornos anteriores são preservados; o payload conflitante aparece no histórico.

### Status

Só `paid` contabiliza receita atribuída. Estados aceitos: `pending`, `paid`, `cancelled`. **Transições permitidas: `pending → paid`, `pending → cancelled`, `paid → cancelled`.** Cancelamento não reabre; `paid → pending` não é permitido. Uma mudança usa um novo `event_id` e `occurred_at` posterior ao da última mudança aceita. Status diferente em um evento antigo é ignorado; empate de horário gera `409`. Mesmo status e mesmos dados do pedido são replay, sem efeito financeiro.

Estornos são aplicados ao saldo do pedido **mesmo em `pending` ou `cancelled`**. A soma aplicada descreve o ledger de reembolso; receita atribuída só conta quando o status é `paid`. Assim, um pedido pendente com estorno passa a contabilizar apenas o líquido ao virar pago. Cancelar zera a contabilização atual, preservando o histórico de valores antes do cancelamento e todos os estornos.

`attribution_state` distingue venda sem criador (`unattributed`), status sem receita (`not_countable`), atribuição ativa (`active`), parcial (`partially_refunded`) e integralmente estornada (`reverted`). Pedido pago de valor zero fica `active` com receita zero; não aparece como revertido se nenhum centavo foi reembolsado.

### Identidade, conflitos e histórico

- Pedido: chave `(store_id, order_id)`. Estorno: `(store_id, refund_id)`. Mesmo pedido pode ter vários estornos distintos.
- Evento: `(store_id, tipo, event_id)`. O tipo separa eventos de pedido e estorno. Mesma chave com o mesmo payload normalizado retorna `duplicate: true`; conteúdo diferente retorna `409 event_identity_conflict`.
- Um novo `event_id` para o mesmo refund não reaplica se `order_id`, `amount_cents` e `occurred_at` forem iguais. Se diferirem, retorna `409 refund_identity_conflict`. Não tente corrigir um estorno mudando seu ID: IDs diferentes representam estornos distintos.
- Campos opcionais ausentes são normalizados para `null`; a ordem das chaves JSON não muda a identidade. Um `event_id` já usado exige também o mesmo `occurred_at`. As respostas de replay mostram o **snapshot atual**, que pode ter recebido estornos depois do primeiro evento; o motivo original do evento permanece.
- Recebimentos novos, replays e conflitos válidos entram em `receipts`, com payload, horário controlável e decisão/snapshot. Cada aplicação de refund gera outro registro `refund_applied`. A sequência persistida ordena o histórico mesmo quando os horários empatam. Payload inválido retorna `400` e não é persistido.
- Eventos, chaves de idempotência e efeitos são gravados juntos em transação `BEGIN IMMEDIATE`. Uma falha reverte tudo, permitindo retry. O SQLite serializa as escritas; `busy_timeout` é de 5 segundos. A consulta auditável também usa uma transação para ler um estado consistente.

### Estornos e teto

Um refund guarda `amount_requested_cents` e `amount_applied_cents`. Aplica `min(solicitado, total - soma já aplicada)`. Excesso fica `capped` com motivo `capped_to_remaining`; o pedido recebido não é rejeitado nem o refund é descartado. Sem saldo, o refund solicitado fica registrado com aplicado zero. Um refund que já foi limitado não cresce depois.

Antes do pedido, o estado é `pending`, o aplicado é zero e `applied_at` é `null`. Quando o pedido chega, as pendências são aplicadas pela **sequência de recebimento persistida**, independentemente do horário que o provedor declarou. A ordem decide qual refund recebe o saldo quando vários excedem o total; a soma permanece limitada em qualquer ordem de chegada. Não há tarefa de fundo nem memória volátil responsável pela pendência. Replay do pedido não desfaz os estornos.

## API e exemplos

IDs de loja, evento, pedido e refund aceitam 1–100 letras ASCII, números, `_` ou `-`. `occurred_at` é obrigatório no formato UTC `YYYY-MM-DDTHH:mm:ss.sssZ`, com data válida. `coupon` e os campos UTM são opcionais, como texto de 1–200 caracteres ou `null`; `utms` pode ser omitido, mas, quando presente, deve ser objeto. Campos desconhecidos são rejeitados. Corpo máximo: 64 KiB.

| Endpoint | Resultado |
|---|---|
| `POST /webhooks/:storeId/orders` | pedido/atualização/replay `200`; conflito `409` |
| `POST /webhooks/:storeId/refunds` | aplicado/pendente/replay `200`; conflito `409` |
| `GET /stores/:storeId/orders/:orderId/attribution` | snapshot, refunds e histórico; `200` inclusive se só há pendência; `404` se nunca houve registro |
| `GET /health` | `200` |

Exemplos abaixo para um banco novo após o seed. Os comandos `curl` usam sintaxe de shell POSIX, como Git Bash. As respostas mostradas são **recortes** dos campos retornados; a API também inclui IDs, horários e o snapshot completo.

### Pedido: cupom de Lia e UTM de Bia

```sh
curl -X POST http://127.0.0.1:3000/webhooks/store_a/orders \
  -H "Content-Type: application/json" \
  -d '{"event_id":"evt_order_001","id":"ord_1001","total_cents":15990,"coupon":"LIA20","utms":{"source":"instagram","campaign":"summer","content":"creator:crt_bia"},"status":"paid","occurred_at":"2026-10-01T15:00:00.000Z"}'
```

```json
{
  "duplicate": false,
  "reason": "order_created",
  "order": {
    "attribution": { "creator_id": "crt_lia", "source": "coupon", "reason": "coupon_precedence" },
    "attributed_gross_cents": 15990,
    "refunded_applied_cents": 0,
    "net_attributed_cents": 15990
  }
}
```

Repita o mesmo request: `duplicate: true`, com os valores atuais preservados. Um novo evento com `id: ord_1001` e outro total resulta em `409 order_identity_conflict`, sem mudar o valor aceito.

O mesmo pedido no PowerShell:

```powershell
$pedido = @{
  event_id = 'evt_order_001'; id = 'ord_1001'; total_cents = 15990
  coupon = 'LIA20'; status = 'paid'; occurred_at = '2026-10-01T15:00:00.000Z'
  utms = @{ source = 'instagram'; campaign = 'summer'; content = 'creator:crt_bia' }
}
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3000/webhooks/store_a/orders' -ContentType 'application/json' -Body ($pedido | ConvertTo-Json -Depth 4)
```

### Estorno parcial

```sh
curl -X POST http://127.0.0.1:3000/webhooks/store_a/refunds \
  -H "Content-Type: application/json" \
  -d '{"event_id":"evt_refund_001","refund_id":"ref_1","order_id":"ord_1001","amount_cents":4000,"occurred_at":"2026-10-03T10:00:00.000Z"}'
```

```json
{
  "duplicate": false,
  "reason": "applied",
  "refund": { "state": "applied", "amount_requested_cents": 4000, "amount_applied_cents": 4000 },
  "order": { "refunded_applied_cents": 4000, "net_attributed_cents": 11990 }
}
```

Repita: continua aplicado apenas 4.000. Envie outro refund, `event_id: evt_2`, `refund_id: ref_2`, de 3.000: o líquido passa a 8.990. Depois, um refund distinto de 20.000 aplica somente 8.990, guarda solicitado 20.000 e zera o líquido com `state: capped`.

### Estorno antes do pedido

```sh
curl -X POST http://127.0.0.1:3000/webhooks/store_a/refunds \
  -H "Content-Type: application/json" \
  -d '{"event_id":"evt_early","refund_id":"ref_early","order_id":"ord_early","amount_cents":4000,"occurred_at":"2026-10-03T10:00:00.000Z"}'
```

```json
{
  "reason": "order_not_received",
  "order": null,
  "refund": { "state": "pending", "amount_requested_cents": 4000, "amount_applied_cents": 0, "applied_at": null }
}
```

Reinicie a API com o mesmo `DB_PATH`. Envie o exemplo de pedido trocando para `id: ord_early` e `event_id: evt_early_order`: a pendência é aplicada e o líquido passa a 11.990.

```sh
curl http://127.0.0.1:3000/stores/store_a/orders/ord_early/attribution
```

Essa consulta retorna `order`, `refunds` e `history`. O primeiro recibo mantém a decisão de pendência; o recibo `refund_applied` mostra a aplicação, solicitado/aplicado e o saldo resultante. Não há exclusão do registro anterior.

## Validação executada

```sh
npm run check
npm run demo
```

`examples/demo.mjs` inicia a API HTTP em porta livre, usa banco isolado em `data/`, faz requests reais, encerra/reinicia o processo, confirma a pendência persistente e limpa apenas seu diretório temporário. Não depende da API em execução nem altera o banco padrão. Usa `assert` e falha com saída diferente de zero se os resultados divergirem. A mesma demonstração faz parte da suíte.

Resultado executado em **Node v22.23.3**: TypeScript/build aprovados e **71 testes verdes em 4 arquivos**. A suíte verifica pedido e refund repetidos, parcial/integral, pendência e reabertura, reinício de processo, conflitos, lojas, transições de status, validações e rollback após falha de escrita. Também percorre as 24 permutações de chegada de um pedido e três refunds, verificando teto e saldo não negativo após cada evento.

Saída medida da demonstração:

```json
{
  "runtime": "v22.23.3",
  "attribution": { "creator_id": "crt_lia", "source": "coupon", "reason": "coupon_precedence" },
  "partial_net_cents": 11990,
  "repeated_refund_net_cents": 8990,
  "cap": { "requested": 20000, "applied": 8990, "net": 0 },
  "conflict_status": 409,
  "restarted_pending_refund_applied_cents": 4000,
  "other_store_creator": "crt_ana",
  "audit_receipts": 11
}
```

O workflow em `.github/workflows/ci.yml` instala pelo lockfile e executa `check` em Node 22.23.3.

## Limites e o que mudaria com mais tempo

Esta é uma demonstração local, ligada ao loopback, sem autenticação de usuários, assinatura Shopify, OAuth ou provider real. `storeId` no caminho organiza os dados; não autentica uma loja. Para receber webhooks externos, adicionaria validação da assinatura e autorização antes de expor a API.

O catálogo local de criadores e a política de congelar total/atribuição simplificam a demonstração. Uma integração real precisaria definir ajustes de pedido, moeda e os estados do provedor. O histórico é completo e sem paginação; em volume maior adicionaria consulta paginada, política explícita de retenção e observabilidade. Não foi medido throughput nem feito teste de carga distribuída. SQLite síncrono foi escolhido para uma API local pequena; produção com várias instâncias exigiria reavaliar a persistência.

## Uso de IA e revisão

A arquitetura, implementação, testes, README e exemplos foram produzidos com apoio de IA (Codex). Houve revisão independente por agentes de IA das regras de atribuição, idempotência, transações, estornos, isolamento por loja, contrato HTTP e testes. Um problema na classificação de pedidos de valor zero foi identificado e corrigido; lacunas de cobertura de status também receberam testes. A validação executada foi automatizada e incluiu Node 22, requests HTTP reais e reinício do processo. **Revisão humana ainda não foi realizada; não se atribui essa revisão a Marco.**
