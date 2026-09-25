# ani-9 — Fase 1: agendador consciente de conteúdo (modo sombra)

Investiga se uma camada de conceitos, combinada ao `R` do FSRS, prevê a recordação do usuário melhor do que o FSRS puro — sem alterar nenhum agendamento real. Ver [`report.md`](./report.md) para a resposta e os números completos.

**Veredito atual: evidência sugestiva** (não confirmada — ver relatório).

## Como rodar

```bash
pnpm install
pnpm test          # suíte completa (unit tests, sem chamadas de API)
```

Para reproduzir a análise final (usa uma classificação já em cache, sem custo de API):

```bash
pnpm analyze:english
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
  analyze-english-concept-model.mts   # pipeline completo que gerou report.md/report.json
```

Cada módulo tem testes próprios em `tests/`, incluindo os testes obrigatórios da especificação original (equivalência com FSRS puro, atribuição de culpa MY/YOUR, recuperação de conceito oculto, ausência de vazamento temporal, parsers para os 3 formatos de `.apkg`, normalização).

### `concepts/`: três abordagens tentadas

1. **Extração aberta por LLM (Anthropic Haiku) + canonicalização por embedding** (`extract.ts`, `canonicalize.ts`, `weights.ts`, `postprocess.ts`) — mantida no código, mas **abandonada**: mesmo depois de várias correções reais (rótulos atômicos, verificação de grupo pós-união, divisão determinística de rótulos compostos), a extração persistia em nomear a gramática do idioma da tradução de apoio em vez do conteúdo estudado, e um limiar fixo de similaridade nunca separou corretamente sinônimos verdadeiros de pares não relacionados.
2. **Modelo de vizinhos por similaridade local, sem LLM** (`model/neighbors.ts`, `model/bm25.ts`) — **resultado negativo**: nenhuma das 3 variantes (embedding, BM25, média) superou o FSRS otimizado com significância, mesmo depois de corrigir um bug real de escala de peso (normalização por linha inflava a confiança em vizinhos fracos).
3. **Lista fixa + classificação em conjunto fechado (Gemini 3.1 Flash-Lite)** (`fixed-list.ts`, `classify.ts`, `vocabulary.ts`) — **adotada**. Uma lista pequena e revisada por humano de conceitos gramaticais/estruturais é gerada uma vez a partir de uma amostra; o vocabulário vira concept por regra determinística (sem LLM); e para cada cartão o LLM só escolhe quais itens da lista fixa se aplicam (pode escolher nenhum). Isso elimina o problema de canonicalização por construção — não há como o LLM criar um conceito novo por cartão.

O modelo bayesiano (`model/bayesian.ts`) é genérico: liga um cartão a "nós" com pesos, atualiza online (variância com deriva por dia, atualização gaussiana fechada), e com todo peso zerado (`λ=0`) é um pass-through exato do FSRS — a mesma classe serve tanto para o modelo de vizinhos (nós = cartões) quanto para o modelo de conceitos (nós = nomes de conceito).

## Limitações conhecidas

- A lista fixa de 22 conceitos foi gerada de uma amostra de 100 cartões de frases de um único baralho — não cobre gramática de tempos verbais (o LLM ignorou essa categoria mesmo quando pedida explicitamente) e não generaliza sem nova geração/revisão.
- O efeito medido se concentra em 532/926 cartões elegíveis (os que têm algum conceito ligando notas distintas) — é uma fração minoritária do baralho.
- Bootstrap por cartão e teste de permutação respondem perguntas diferentes e podem divergir — como aconteceu aqui (permutação significativa, bootstrap ainda cruzando zero).
- `elapsed_days` do FSRS usa diferença de dia-calendário UTC, não o horário de virada de dia configurado no Anki do usuário.
- Sem UI, sem seletor de próximo cartão, sem qualquer alteração no agendamento real — por escopo (Fase 1 é modo sombra).

Detalhes completos, métricas e os dois controles (recalibração e permutação) em [`report.md`](./report.md) / [`report.json`](./report.json).
