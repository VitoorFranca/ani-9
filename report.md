# Fase 1 — Agendador consciente de conteúdo: relatório final

**Pergunta da Fase 1:** a camada de conceitos prevê a recordação do usuário melhor do que o FSRS puro, nos dados reais dele?

**Veredito: sem evidência de transferência por conteúdo neste baralho.** O único efeito estatisticamente significativo encontrado é explicado por um controle trivial — o notetype do cartão, sem palavras, sem LLM, sem qualquer noção de conceito compartilhado. Ver [Ablação e controles](#ablação-e-controles).

## Resumo do baralho

`data/English.apkg`: 13.523 cartões totais, **926 elegíveis** (revisados e com conteúdo), distribuídos em 4 notetypes (Phrasal Verbs, Idiomatic Expressions, 4000 EEW, 4000 EEW Extra). 18.953 entradas de revlog brutas, **5.157 revisões mantidas** após o filtro (13.523 resets em massa, todos numa janela de 14s — artefato de importação, não ação do usuário). Razão cartão:nota = 1.00 (sem cartões-irmãos).

## O caminho até aqui

Três abordagens foram tentadas para a camada de conceitos:

1. **Extração aberta por LLM (Anthropic Haiku) + canonicalização por embedding.** Abandonada: rótulos compostos, colapso da canonicalização por limiar fixo, e persistência do erro de nomear a gramática da tradução em vez do conteúdo estudado.
2. **Modelo de vizinhos por similaridade local** (embeddings + BM25, sem LLM). Corrigido um bug real de escala de peso, mas nenhuma variante superou o FSRS com significância — descartado.
3. **Lista fixa de conceitos (Gemini 3.1 Flash-Lite) + vocabulário por regra.** Resolveu o problema de canonicalização por construção (lista fixa revisada por humano, LLM só classifica em conjunto fechado). Pareceu funcionar inicialmente — mas a ablação abaixo mostra que não funcionava pelo motivo certo.

## Resultado inicial (antes da ablação)

No recorte "cartões com ≥1 conceito ligando notas distintas" (n=532), o modelo combinado (lista fixa + vocabulário) batia o FSRS otimizado (log-loss 0.1461 vs 0.1603), sobrevivia à recalibração de viés global, e vencia 1000 permutações da atribuição conceito→cartão (p≈0.001). Isso parecia evidência forte. A ablação abaixo, pedida antes de aceitar esse resultado, mostra por que não era.

## Ablação e controles

Todos os controles rodaram **localmente, sem chamadas de API**, reaproveitando a classificação já em cache. Mesmo protocolo em todos: busca em grade (`priorVariance`, `driftPerDay`, `λ`) só no treino, avaliação no recorte cross-note fixo (n=532), bootstrap por cartão contra o FSRS otimizado, e 1000 permutações da atribuição cartão→conceito — cada permutação refazendo a mesma busca em grade no treino (não reaproveita os hiperparâmetros do modelo real).

| # | Variante | Log-loss | Bootstrap vs FSRS (IC95%) | Permutação (1000x) |
|---|---|---|---|---|
| — | FSRS otimizado (referência) | 0.1603 | — | — |
| 1 | Só lista fixa (22 conceitos, LLM) | 0.1709 (pior) | Δ=-0.0110, [-0.0307, 0.0057] | p≈0.966 — **indistinguível de ruído** |
| 2 | Só vocabulário (com palavras funcionais) | 0.1444 | Δ=0.0158, **[0.0006, 0.0289]** | p≈0.001 |
| 3 | Vocabulário sem palavras funcionais | 0.1550 | Δ=0.0052, [-0.0047, 0.0130] | p≈0.001 |
| 4 | Lista fixa + vocabulário sem funcionais | 0.1559 | Δ=0.0043, [-0.0074, 0.0134] | p≈0.001 |
| 5 | Controle: nó global único (1 nó para todo cartão) | 0.1586 | Δ=0.0017, [-0.0060, 0.0093] | n/a (embaralhar não muda nada) |
| **6** | **Controle: nó por notetype** (4 valores, sem palavras) | **0.1428 (melhor de todas)** | **Δ=0.0175, [0.0024, 0.0309]** | p≈0.001 |
| 7 | Controle: nó por tamanho do front (1 / 2-4 / 5+ palavras) | 0.1505 | Δ=0.0096, [-0.0146, 0.0274] | p≈0.001 |

**Leitura:**

- **A lista fixa por LLM (variante 1) não carrega sinal algum** — pior que o FSRS, e 96,6% de 1000 permutações aleatórias empatam ou superam o resultado real. Todo o trabalho de geração e classificação por LLM não contribuiu.
- **Só o vocabulário com palavras funcionais (variante 2) e o notetype (variante 6) têm bootstrap fora de zero.** O notetype — um rótulo trivial de qual dos 4 notetypes o cartão pertence, sem nenhuma palavra — é o **melhor resultado de toda a investigação**.
- **Palavras funcionais (the, is, to, a...) aparecem quase exclusivamente nos notetypes de frase** (Phrasal Verbs/Idiomatic Expressions). Isso torna "vocabulário com funcionais" um proxy indireto de "este cartão é de frase ou de palavra isolada" — exatamente o que o notetype captura diretamente e melhor. Sem as palavras funcionais (variante 3) ou usando um proxy mais fraco como tamanho (variante 7), o efeito não é significativo.
- **O controle de nó global único (variante 5) não recupera o desempenho do vocabulário completo** (0.1586 vs 0.1444) — descarta a hipótese de que o vocabulário fosse "só" uma recalibração de viés único; mas isso não importa mais, porque o notetype sozinho já explica o efeito melhor do que o vocabulário.

**Conclusão da ablação:** o único efeito que sobrevive a bootstrap e permutação ao mesmo tempo (notetype) não depende de conteúdo, vocabulário ou qualquer noção de conceito compartilhado entre cartões — é heterogeneidade de dificuldade entre os 4 notetypes do baralho, que o FSRS otimizado (um único conjunto de parâmetros para o baralho inteiro) não captura sozinho. Isso não confirma a hipótese da Fase 1.

## Controle adicional: FSRS recalibrado

Antes da ablação, testamos se o resultado inicial era só recalibração genérica: um único ajuste de viés global (ajustado no treino) melhora o FSRS de 0.1603 para 0.1565 — bem menos que qualquer uma das variantes com bootstrap significativo. Não explica os resultados por si só, mas também não é a explicação real (que acabou sendo o notetype).

## Custo

Abordagem da lista fixa: 25 chamadas ao Gemini 3.1 Flash-Lite, **US$0,065 total**. Toda a ablação e os controles (7 variantes × grid search × bootstrap × 1000 permutações cada) rodaram localmente, sem custo adicional de API. Tentativas anteriores descartadas: ~US$1,13 em extração aberta via Anthropic Haiku (CIMV.apkg).

## Limitações conhecidas

- **Limitação principal:** este baralho é majoritariamente composto de itens isolados — cartões de vocabulário de palavra única (54% dos elegíveis, nos notetypes "4000 EEW"/"4000 EEW Extra"), sem contexto compartilhado com outros cartões. Há pouco conhecimento genuinamente compartilhado entre cartões para uma camada de conceitos explorar. Os notetypes de frase têm mais estrutura, mas mesmo ali o efeito não sobreviveu aos controles como conteúdo genuíno.
- O resultado significativo (notetype) sugere que o ganho real disponível é heterogeneidade de dificuldade **entre notetypes**, não entre conceitos — um problema mais simples, que nem exigiria uma camada de conceitos: FSRS com parâmetros por notetype (em vez de um conjunto único para o baralho todo) provavelmente já capturaria a maior parte desse ganho.
- Razão cartão:nota = 1.00 neste baralho — não testado em baralho com cloze/reversos.
- A lista fixa de conceitos por LLM (o componente mais caro e complexo) não teve efeito aqui. Não se sabe se isso é uma falha do método ou se baralhos com mais estrutura gramatical/conceitual compartilhada se beneficiariam mais.
- Confirmação exigiria repetir a variante mais promissora em dados novos — outro baralho, ou mais revisões do mesmo. Os resultados vêm de uma única amostra de 532 cartões avaliáveis, insuficiente para confirmação independente do teste de permutação.
- `elapsed_days` do FSRS usa diferença de dia-calendário UTC, não o horário de virada de dia configurado no Anki do usuário (aproximação já assumida desde o módulo `fsrs`).
