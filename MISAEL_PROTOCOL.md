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

## Emendas registradas APÓS ver resultados preliminares (exploratórias, não pré-registradas)

Tudo nesta seção foi decidido depois de rodar a variante principal e observar um resultado preliminar ruim — registrado explicitamente como pós-hoc/exploratório, ao contrário do resto deste documento.

### 1. Correção: normalização do conceito por média, não soma

Uma rodada preliminar mostrou a variante principal com previsões saturando em 0,0000/1,0000 exatos no teste (log-loss explodindo). Causa: cada palavra de vocabulário de um cartão contribuía independentemente com peso `λ`, então cartões com mais palavras distintas recebiam um deslocamento de log-odds proporcionalmente maior — com temas por palavra tendo poucas observações, isso saturava a previsão. **Corrigido**: peso de cada conceito = `λ / número de conceitos do cartão` (média, não soma). Cartões com 1 único rótulo (deck/notetype/global) não são afetados (dividir por 1).

### 2. Correção: gate de `includedInEval` também no treino

Bug de implementação (não decisão de protocolo): a pontuação da busca em grade no treino estava contando **todas** as revisões de treino, inclusive repetições no mesmo dia, em vez de exigir `includedInEval` (gap ≥1 dia) como o protocolo do English.apkg exige mesmo para a pontuação de treino. Corrigido para exigir `includedInEval` também no treino — o modelo continua sendo atualizado (`predictAndUpdate`) em toda revisão de treino continuamente; só a pontuação usada para escolher hiperparâmetros passou a ser filtrada.

### 3. Diagnóstico do FSRS: por que ele perde para a constante

Uma rodada preliminar mostrou o FSRS otimizado perdendo para a baseline constante (taxa do treino) nos dois splits, e os 4 primeiros parâmetros otimizados (estabilidade inicial por nota Again/Hard/Good/Easy) colapsando no mesmo valor. Investigado com 5 checagens, sem API, sem permutação:

1. **Controle no English.apkg**: reotimizado, os 4 primeiros parâmetros ficaram distintos (`[0.2849, 2.1383, 4.4924, 43.3663]`) — o pipeline/otimizador não está quebrado de forma geral.
2. **Cobertura do otimizador**: 1.154 de 1.321 cartões de treino contribuíram itens ao otimizador; a avaliação do FSRS no treino dá o mesmo log-loss (0,5735) filtrando só por esses cartões ou não — não há divergência de cobertura (matematicamente, todo cartão com revisão `includedInEval` no treino necessariamente contribuiu ao otimizador, e vice-versa).
3. **Primeira nota / início com type=0**: 93,2% dos 1.573 cartões começam com etapa de aprendizado (saudável); primeira nota Easy=776 (49%, mais alto que o normal), Again=121, Hard=328, Good=348.
4. **Otimização por baralho, separadamente**: os 4 primeiros parâmetros **colapsam nos 3 baralhos individualmente** (não é artefato de misturar 3 assuntos) — Língua Portuguesa: `[0.3626]×4`; Direito Administrativo: `[0.1693, 0.3675, 0.3675, 0.3675]`; Administração Pública: `[0.1711, 0.1711, 0.1711, 1.5308]`.
5. **Consistência timestamp vs ivl/lastIvl**: ordenação/pareamento corretos (`prev.ivl == cur.lastIvl` em 95,1% dos pares consecutivos), mas os valores absolutos revelam uso extremamente irregular — etapas de reaprendizado agendadas para minutos (`ivl` negativo, em segundos) seguidas de gaps reais de dezenas a centenas de dias antes da próxima revisão, repetidamente, nos 3 baralhos.

**Conclusão do diagnóstico**: não é um bug de parsing/pipeline (itens 1, 2 e 5 descartam isso). É uso real extremamente irregular (longas pausas entre sessões de estudo) que impede o otimizador de separar as 4 estabilidades iniciais por nota nestes baralhos especificamente — diferente do English.apkg, com uso mais regular.

### 4. Nova base e nova variante (substituem o critério de sucesso original)

Dado que o FSRS puro é uma baseline fraca aqui (perde para a constante) mas o nó por baralho melhora substancialmente sobre ele, o teste principal passa a ser:

- **Nova base**: FSRS + nó por baralho (o controle "nó por baralho" já rodado, sem mudança).
- **Nova variante**: FSRS + nó por baralho + vocabulário sem funcionais, todos no mesmo grafo por cartão (`[deck:X, palavra1, palavra2, ...]`), com a mesma normalização por média (peso = `λ / total de rótulos do cartão`, incluindo o rótulo de deck nessa contagem).
- **Novo critério de sucesso**: a variante vence a nova base com IC95% do bootstrap (por cartão) inteiramente a favor, **e** uma permutação que embaralha **só a atribuição de vocabulário** (o rótulo de deck permanece fixo, não embaralhado, em cada permutação) dá p < 0,05, refazendo a busca em grade a cada permutação.
- As variantes/controles originais (principal sozinha, deck sozinho, notetype sozinho, global, e a comparação por embedding, ainda pendente) continuam sendo reportadas como informação suplementar, não fazem mais parte do critério de sucesso.

### 5. Correção: λ separados para deck e vocabulário na variante combinada

Uma rodada preliminar usava um único `λ` compartilhado entre o rótulo de deck e as palavras de vocabulário no mesmo grafo — a contagem de rótulos usada para a média (`λ / total de rótulos`) incluía o rótulo de deck, diluindo seu peso conforme o cartão tinha mais palavras. **Corrigido**: `lambdaDeck` e `lambdaVocab` são hiperparâmetros independentes, cada um com sua própria grade (`{0, 0.25, 0.5, 1, 2}`), grade conjunta 4D (`priorVariance × driftPerDay × λ_deck × λ_vocab`, 100 combinações). A normalização por média se aplica só dentro do grupo de vocabulário (peso de cada palavra = `λ_vocab / número de palavras do cartão`); o rótulo de deck usa `λ_deck` diretamente, sem diluição.

Verificação de equivalência (pedida antes de aceitar o resultado): com `λ_vocab=0` e os mesmos `priorVariance`/`driftPerDay`/`λ_deck` do controle "deck sozinho", a variante combinada precisa reproduzir exatamente o controle "deck sozinho" no teste. **Uma primeira tentativa falhou** (diferença ponto-a-ponto de até 0,44): cartões sem texto útil (contentless, ausentes de `deckByCard`) recebiam um rótulo `deck:undefined` na variante combinada, mas eram tratados como "sem links → previsão = FSRS puro" no controle "deck sozinho". **Corrigido** para a variante combinada também cair no fallback "sem links" quando o cartão não tem baralho atribuído, igual às outras variantes. Após a correção: diferença ponto-a-ponto = 0 exatamente.

## Resultado final da emenda (item 4 + 5 acima)

Com o bug do item 5 corrigido e confirmado (diferença = 0), o bootstrap por cartão (3.000 iterações, o número final, não um ensaio) deu: **combinada (FSRS+deck+vocabulário) vs nova base (FSRS+deck) → Δ=-0,0046, IC95%=[-0,0074, -0,0016]** — inteiramente contrário à variante (a base sozinha vence, com margem pequena mas estatisticamente clara, IC não cruza zero).

**Por regra definida antes de ver este resultado**: como o IC do bootstrap não favorece a variante, as 1000 permutações completas não foram rodadas (não fariam a variante passar no critério, que já exige as duas condições — IC a favor E p<0,05 — e a primeira já falhou). **Este é o resultado final da emenda**: adicionar vocabulário sem funcionais por cima do sinal de baralho não melhora a previsão neste conjunto de baralhos — o nó por baralho sozinho já captura o essencial do sinal disponível, e o vocabulário, na melhor configuração de hiperparâmetros encontrada, ainda piora ligeiramente.

Pendente: a comparação com vizinhos por embedding (`embed-misael.mts`, ainda não aprovado para rodar) não entra nesta conclusão.
