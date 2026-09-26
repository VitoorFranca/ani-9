# ani-9 — Fase 1: agendador consciente de conteúdo (modo sombra)

Investiga se uma camada de conceitos, combinada ao `R` do FSRS, prevê a recordação do usuário melhor do que o FSRS puro — sem alterar nenhum agendamento real. Ver [`report.md`](./report.md) para a resposta e os números completos.

**Veredito atual: sem evidência de transferência por conteúdo neste baralho.** O único efeito estatisticamente significativo encontrado é explicado por um controle trivial (o notetype do cartão), não por conceitos ou vocabulário compartilhado — ver relatório.

Um segundo teste, no dataset público KARL (`nbalepur/KARL`), foi encerrado antes de rodar a análise principal por falta de poder estatístico no regime de revisão espaçada (só 6 de 543 usuários tinham revisões suficientes com intervalo ≥1 dia) — inconclusivo, não um resultado a favor ou contra. Ver [`KARL_REPORT.md`](./KARL_REPORT.md) e [`KARL_PROTOCOL.md`](./KARL_PROTOCOL.md).

## Como rodar

```bash
pnpm install
pnpm test          # suíte completa (unit tests, sem chamadas de API)
```

Para reproduzir a análise final (usa uma classificação já em cache, sem custo de API):

```bash
pnpm analyze:english
npx tsx scripts/ablation-english-concept-model.mts   # ablação + controles, também sem API
```

Para rodar do zero (com chamadas reais à API do Gemini, custo ~US$0,065): apague `cache/classify-english-fixed-list.json` antes, e defina `GOOGLE_API_KEY` (ou `GEMINI_API_KEY`) em um `.env` na raiz.

Coloque seu `.apkg` em `./data/` (não versionado — ver `.gitignore`).

## Arquitetura

```
src/
  ingest/       # .apkg (zip + zstd + sqlite) → Note/Card/Review de domínio
  content/      # normalização de HTML/cloze/mídia, front/back
  embeddings/   # embeddings locais (Xenova/multilingual-e5-small) com cache em disco
  fsrs/         # replay cronológico + otimização de parâmetros (ts-fsrs + binding)
  eval/         # log-loss, AUC, calibração, bootstrap por cartão
  model/        # BM25, vizinhos por similaridade, modelo bayesiano genérico
  concepts/     # extração/classificação de conceitos (3 abordagens, ver abaixo)
scripts/
  analyze-english-concept-model.mts   # pipeline que gerou o resultado inicial
  ablation-english-concept-model.mts  # ablação (4 variantes) + 3 controles que revisaram o veredito
```

Cada módulo tem testes próprios em `tests/`, incluindo os testes obrigatórios da especificação original (equivalência com FSRS puro, atribuição de culpa MY/YOUR, recuperação de conceito oculto, ausência de vazamento temporal, parsers para os 3 formatos de `.apkg`, normalização).

### `concepts/`: três abordagens tentadas, nenhuma confirmada

1. **Extração aberta por LLM (Anthropic Haiku) + canonicalização por embedding** (`extract.ts`, `canonicalize.ts`, `weights.ts`, `postprocess.ts`) — mantida no código, mas **abandonada**. Passou por várias correções reais (rótulos atômicos, verificação de grupo pós-união, divisão determinística de rótulos compostos, e — na última rodada — separar PERGUNTA/RESPOSTA no prompt para parar de nomear a gramática da tradução de apoio em vez do conteúdo estudado, o que resolveu esse problema específico). Abandonada mesmo assim: erros de gramática persistiam nos rótulos, e o custo de chamadas repetidas à API da Anthropic (~US$1,71 acumulado no CIMV.apkg) não compensava.
2. **Modelo de vizinhos por similaridade local, sem LLM** (`model/neighbors.ts`, `model/bm25.ts`) — **resultado negativo**: nenhuma das 3 variantes (embedding, BM25, média) superou o FSRS otimizado com significância, mesmo depois de corrigir um bug real de escala de peso (normalização por linha inflava a confiança em vizinhos fracos).
3. **Lista fixa + classificação em conjunto fechado (Gemini 3.1 Flash-Lite)** (`fixed-list.ts`, `classify.ts`, `vocabulary.ts`) — resolveu o problema de canonicalização por construção (lista fixa revisada por humano, LLM só classifica em conjunto fechado). Pareceu bater o FSRS a princípio, mas uma ablação em 4 variantes + 3 controles (recalibração, permutação, nó por notetype, nó por tamanho) mostrou que a lista fixa não carrega sinal algum, e que o efeito do vocabulário é majoritariamente explicado pelo notetype do cartão (sem palavras, sem LLM) — não por conteúdo lexical compartilhado.

O modelo bayesiano (`model/bayesian.ts`) é genérico: liga um cartão a "nós" com pesos, atualiza online (variância com deriva por dia, atualização gaussiana fechada), e com todo peso zerado (`λ=0`) é um pass-through exato do FSRS — a mesma classe serviu para o modelo de vizinhos (nós = cartões), o modelo de conceitos (nós = nomes de conceito) e todos os controles da ablação (nós = notetype, faixa de tamanho, nó global único).

## Limitações conhecidas

- **Principal:** este baralho é majoritariamente de itens isolados — 54% dos cartões elegíveis são vocabulário de palavra única, sem contexto compartilhado com outros cartões. Há pouco conhecimento genuinamente compartilhado entre cartões para uma camada de conceitos explorar.
- O único efeito significativo encontrado (heterogeneidade entre os 4 notetypes do baralho) nem exigiria uma camada de conceitos — FSRS com parâmetros por notetype provavelmente já capturaria a maior parte desse ganho.
- Bootstrap por cartão e teste de permutação respondem perguntas diferentes e podem divergir, como aconteceu em etapas intermediárias desta investigação.
- `elapsed_days` do FSRS usa diferença de dia-calendário UTC, não o horário de virada de dia configurado no Anki do usuário.
- Sem UI, sem seletor de próximo cartão, sem qualquer alteração no agendamento real — por escopo (Fase 1 é modo sombra).

Detalhes completos, a tabela de ablação com as 7 variantes/controles, e a metodologia de cada teste em [`report.md`](./report.md) / [`report.json`](./report.json).
