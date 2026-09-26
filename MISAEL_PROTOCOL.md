# Protocolo pré-registrado — teste nos baralhos do Misael

Registrado **antes** de rodar qualquer variante ou controle, conforme instrução explícita do usuário. Nada aqui deve mudar depois de ver resultados.

## Dados

- 3 baralhos em `data/misael/` (`.apkg`, AnkiDroid), um único usuário: `01. Lingua Portuguesa (Geral).apkg`, `04. Direito Administrativo.apkg`, `07. Administracao Publica.apkg`.
- Ingeridos separadamente e depois combinados (concatenados) numa única coleção para treino/avaliação conjunta. Verificado antes de combinar: **nenhuma colisão de `cardId`** entre os 3 baralhos (1.754 IDs únicos, batendo com a soma dos cartões de cada um) — Anki usa timestamp de criação como id, então a combinação é segura.
- **Achado relevante, registrado antes de rodar**: os 3 baralhos compartilham o **mesmo e único notetype** (`Básico`, id `1687060289241`) — não há diversidade de notetype entre eles. Isso torna o controle "nó por notetype" **estruturalmente idêntico ao controle "nó global único"** (todo cartão cai no mesmo nó nos dois casos): as previsões e o log-loss serão idênticos entre essas duas linhas do relatório. Não é um erro de implementação; é uma característica real destes dados. O controle é rodado mesmo assim, como pedido, com essa equivalência já esperada e documentada.
- Split cronológico 70/30 sobre o conjunto combinado de revisões mantidas (`splitChronological`, mesmo método do English/KARL).
- Avaliação restrita a **revisões espaçadas (≥1 dia)** (`includedInEval` do `replayCard` padrão — dias inteiros; não se aplica aqui a correção fracionária do KARL, pois isto é Anki real com granularidade normal de dias, já verificada como não-degenerada no English.apkg).
- FSRS otimizado **só no treino** (`optimizeParameters`, com `enableShortTerm: true`, já o padrão do módulo).

## Conteúdo do cartão

**Frente + verso** (`NormalizedCard.text`, que já é front+back concatenado), não front isolado — decisão explícita do usuário para este teste (diferente do English/KARL, que usaram só a frente/pergunta).

## Variante principal

Vocabulário sem palavras funcionais em português: `extractVocabularyConcepts(card.text, { excludeFunctionWords: true, functionWords: PORTUGUESE_FUNCTION_WORDS })` (lista adicionada a `src/concepts/vocabulary.ts` para este teste).

## Comparações e controles

1. **Vizinhos por embedding local** (similaridade) — `computeNeighborSets` sobre `card.text`, k=5, self-link peso 1 + `rescaleSimilarity(tau, lambda)` nos vizinhos.
2. **Nó por baralho** (3 valores — um por arquivo `.apkg`, sem alterar/agrupar).
3. **Nó por notetype** (1 valor só, ver achado acima — resultado esperado idêntico ao nó global).
4. **Nó global único.**

## Grades de hiperparâmetros (fixadas antes de rodar)

- Variantes de conceito (principal, deck, notetype, global): `priorVariance ∈ {0.25, 1}`, `driftPerDay ∈ {0.001, 0.01}`, `lambda ∈ {0, 0.25, 0.5, 1, 2}` — mesma grade do English.apkg e do KARL.
- Vizinhos por embedding: mesma grade de `priorVariance`/`driftPerDay`, mais `tau ∈ {0.5, 0.7, 0.85, 0.95}`, `lambda ∈ {0, 0.25, 0.5, 1, 2}` — mesma grade nova fixada para o teste do KARL, reaproveitada aqui por consistência.

## Bootstrap

Por **cartão** (não por usuário — há um só usuário aqui, ao contrário do KARL), 2000 iterações, seed 42 — `bootstrapLogLossDelta`, o mesmo método do English.apkg.

## Permutação (1000x)

Embaralha a atribuição cartão→rótulo (concept-list, ou lista de vizinhos no caso da variante de embedding) e refaz a busca em grade em cada uma das 1000 permutações (nunca reaproveita os hiperparâmetros do modelo real). Roda para: **principal, deck, notetype, embedding**. **Não roda para o nó global único** — embaralhar uma atribuição uniforme não muda nada, mesmo motivo já documentado no English.apkg e no KARL. Pela equivalência estrutural acima, a permutação do nó por notetype também será uma repetição exata da do nó global em espírito (um só rótulo), mas é executada mesmo assim por ter sido pedida explicitamente.

Para a variante de vizinhos por embedding, "embaralhar" significa: permutar qual conjunto de vizinhos pré-computado (por card_id) cada cartão realmente revisado usa, mantendo fixas as revisões e seus `predictedR`.

## Critério de sucesso

A variante principal precisa vencer, com **IC95% do bootstrap inteiramente a favor** (não cruza zero, na direção certa): (a) FSRS otimizado, (b) o nó por baralho, (c) o nó por notetype, e (d) a variante de vizinhos por embedding. **E** a permutação da variante principal precisa dar **p < 0,05**. Todas as condições são necessárias — vencer só algumas não conta como sucesso.

## Relato suplementar

Resultados por baralho individual (log-loss/AUC restrito às revisões espaçadas de cada `.apkg`) são reportados à parte, como informação suplementar — não entram no critério de sucesso.

## Restrição

Nenhuma chamada a API de modelo (Anthropic, Google etc.). Embeddings locais (`@huggingface/transformers`) são permitidos.
