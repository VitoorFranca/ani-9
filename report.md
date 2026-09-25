# Fase 1 — Agendador consciente de conteúdo: relatório final

**Pergunta da Fase 1:** a camada de conceitos prevê a recordação do usuário melhor do que o FSRS puro, nos dados reais dele?

**Veredito: evidência sugestiva.** Não confirmado — o bootstrap por cartão contra o FSRS ainda cruza zero, mesmo com o teste de permutação (mais direto e mais rigoroso) fortemente significativo (p≈0.001, 1000 permutações). Ver [Controles](#controles) e [Como este veredito foi decidido](#como-este-veredito-foi-decidido).

## Resumo do baralho

`data/English.apkg`: 13.523 cartões totais, **926 elegíveis** (revisados e com conteúdo). 18.953 entradas de revlog brutas, **5.157 revisões mantidas** após o filtro (73% descartadas — 13.523 delas são resets em massa, `type=4/factor=0`, todos dentro de uma janela de 14 segundos, um artefato de importação do baralho, não ações manuais do usuário). Razão cartão:nota = 1.00 (sem cartões-irmãos neste baralho).

## O caminho até aqui

Três abordagens foram tentadas para a camada de conceitos, nessa ordem:

1. **Extração aberta por LLM (Anthropic Haiku) + canonicalização por similaridade de embedding.** Abandonada depois de várias rodadas de correção real: rótulos compostos (gramática e vocabulário misturados no mesmo nome), colapso da canonicalização por limiar fixo (0.88) — calibrado contra pares reais, nenhum limiar separa corretamente sinônimos verdadeiros de pares não relacionados — e, mesmo depois de consertar isso com verificação de grupo e divisão determinística de rótulos, a extração continuou nomeando a gramática do português da tradução em vez do inglês estudado, seu erro mais persistente.
2. **Modelo de vizinhos por similaridade local** (embeddings + BM25, sem LLM). A normalização de peso por linha inflava artificialmente a confiança em vizinhos fracos (corrigida com escala absoluta + parâmetros τ/λ), mas mesmo corrigido, nenhuma das 3 variantes (embedding, BM25, média) superou o FSRS otimizado com significância no teste — resultado negativo, descartado.
3. **Lista fixa de conceitos + classificação em conjunto fechado (Gemini 3.1 Flash-Lite)** + vocabulário por regra determinística. Esta é a abordagem adotada: elimina o problema de canonicalização por construção — a lista de conceitos é gerada uma vez, revisada por humano, e o LLM só escolhe entre itens já existentes para cada cartão (pode escolher nenhum), nunca cria conceitos novos.

## A abordagem final

- **Lista fixa** (22 conceitos): gerada a partir de uma amostra de 100 cartões priorizando frases (Phrasal Verbs / Idiomatic Expressions), com critério de granularidade explícito ("dois conceitos são diferentes se alguém pode saber um sem saber o outro"), exigindo pelo menos 2 exemplos citados por conceito, validados contra a amostra real. Revisada e aprovada antes do uso.
- **Vocabulário** (1.528 conceitos): cada palavra distinta do `front` de um cartão vira um conceito, por regra, sem LLM.
- **Classificação**: para cada um dos 926 cartões elegíveis, o Gemini escolhe quais dos 22 conceitos da lista fixa se aplicam (pode escolher nenhum) — 24 chamadas, 0 falhas, custo real **US$0,065**.
- **Modelo**: adaptação genérica do modelo bayesiano online da especificação original — em vez de ligar um cartão aos seus "conceitos" com pesos de centralidade, liga um cartão diretamente aos nomes dos conceitos que ele tem (lista fixa + vocabulário), sem peso de auto-ligação. Com λ=0, o modelo é um pass-through exato do FSRS (testado); a busca em grade (`priorVariance`, `driftPerDay`, `λ`) roda só no treino e nunca pode piorar o baseline por construção.

## Métricas

### Todos os cartões elegíveis para avaliação (n=1095)

| Modelo | Log-loss | AUC | Calib. RMSE |
|---|---|---|---|
| Constante (taxa do treino) | 0.2859 | 0.5000 | 0.0223 |
| FSRS otimizado | 0.2608 | 0.7430 | 0.0369 |
| **Conceitos** | **0.2589** | **0.7609** | 0.0653 |

Bootstrap por cartão (FSRS vs. conceitos): Δ=0.0019, IC95%=[-0.0065, 0.0091] — cruza zero.

### Só cartões com ≥1 conceito ligando notas distintas (n=532)

Este é o recorte relevante para testar a hipótese: cartões cujo único vínculo conceitual é vocabulário raro (aparece em 1 nota só) não têm como se beneficiar de transferência real.

| Modelo | Log-loss | AUC | Calib. RMSE |
|---|---|---|---|
| Constante | 0.1493 | 0.5000 | 0.0270 |
| FSRS otimizado | 0.1603 | 0.6937 | 0.0650 |
| **Conceitos** | **0.1461** | **0.7280** | 0.0809 |

Bootstrap por cartão (FSRS vs. conceitos): Δ=0.0141, IC95%=[-0.0027, 0.0285] — ainda cruza zero, mas por pouco (limite inferior a -0.0027).

## Controles

Dois controles foram pedidos antes de aceitar o resultado acima, ambos no recorte "cross-note" (n=532):

**1. FSRS recalibrado** (um único ajuste de viés global, ajustado no treino): melhora pouco o FSRS (0.1603 → 0.1565). O modelo de conceitos continua melhor (0.1461) mesmo contra essa versão recalibrada — Δ=0.0102, IC95%=[-0.0066, 0.0242]. **O ganho não é explicado por recalibração genérica.**

**2. Conceitos embaralhados** (1000 permutações, cada uma refazendo a mesma busca em grade de `priorVariance`/`driftPerDay`/`λ` no treino — não reaproveitando os hiperparâmetros do modelo real):

| | Log-loss |
|---|---|
| Real (conceitos verdadeiros) | **0.1461** |
| Permutações — mínimo | 0.1600 |
| Permutações — média | 0.1700 |
| Permutações — p95 | 0.1833 |
| Permutações — máximo | 0.1972 |

**0 das 1000 permutações igualou ou superou o resultado real** (p empírico ≈ 0.001). O valor real fica abaixo até do melhor caso entre 1000 embaralhamentos, mesmo dando a cada permutação a mesma chance de reajustar os hiperparâmetros. Isso é evidência forte de que o conteúdo específico dos conceitos — não apenas a flexibilidade do modelo — é o que produz o ganho.

## Como este veredito foi decidido

Por instrução explícita: o resultado é classificado como **"evidência sugestiva"**, não confirmada, porque o bootstrap por cartão contra o FSRS continua cruzando zero (tanto na versão simples quanto contra o FSRS recalibrado), mesmo com o teste de permutação fortemente significativo (p<0.05). O bootstrap mede a incerteza de amostragem sobre a magnitude observada do efeito; o teste de permutação mede se o conteúdo dos conceitos importa (versus aleatório). Os dois testes respondem perguntas diferentes, e neste caso divergem: há evidência forte de que o mecanismo é real (permutação), mas a amostra (532 cartões avaliáveis) não é grande o bastante para que a magnitude do efeito fique confiavelmente acima de zero.

## Amostra de conceitos (lista fixa completa, 22 itens)

```
phrasal verb: get away with, pass away, sleep over, call off, pull together,
come up with, find out, back up, dress up, go back, keep on, sober up
expressão idiomática: take for granted, long shot, when it comes to,
so far so good, not my cup of tea, can't help but, at all, go against,
I'll have you know, might as well
```

Cobertura por nota (número de notas distintas que cada conceito liga): entre 8 e 20 — nenhum conceito da lista fixa caiu na categoria "liga só 1 nota".

## Custo

Abordagem final (lista fixa + classificação): **25 chamadas, US$0,065 total**, Gemini 3.1 Flash-Lite, `thinkingLevel: MINIMAL`. Tentativas anteriores descartadas: ~US$1,13 em extração aberta via Anthropic Haiku (CIMV.apkg, todas as iterações) e ~US$0,004 na geração inicial da lista fixa.

## Limitações conhecidas

- A lista fixa (22 conceitos) foi gerada de uma amostra de 100 cartões de frases (Phrasal Verbs/Idiomatic Expressions) — não cobre tempos verbais/gramática (o modelo ignorou essa categoria em duas tentativas mesmo quando pedida explicitamente) e não generaliza a outros baralhos/idiomas sem nova geração e revisão.
- Apenas 532/926 cartões elegíveis (57%) têm algum conceito que liga notas distintas — o efeito medido está concentrado nessa fração minoritária do baralho.
- Este baralho tem razão cartão:nota = 1.00 (sem cloze/reversos) — a categoria "same-note-only" aqui equivale a "conceito raro (aparece em 1 nota)", não a um artefato de cartões-irmãos triviais; o comportamento pode diferir em baralhos com muitos cartões-irmãos.
- `elapsed_days` do FSRS usa diferença de dia-calendário UTC, não o horário exato de virada de dia configurado no Anki do usuário (aproximação já assumida desde o módulo `fsrs`, não específica desta análise).
- Bootstrap e teste de permutação respondem perguntas diferentes e podem divergir, como aconteceu aqui — nenhum dos dois isoladamente decide a questão.
