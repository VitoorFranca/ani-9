# Protocolo pré-registrado — teste no dataset KARL

Registrado **antes** de rodar qualquer variante ou controle, conforme instrução explícita do usuário. Nada aqui deve mudar depois de ver resultados.

**Este teste foi encerrado antes da análise principal ser executada — ver [`KARL_REPORT.md`](./KARL_REPORT.md).** Este arquivo documenta o protocolo e as duas emendas feitas antes de ver qualquer resultado sobre a hipótese (filtro de "avaliável" inviável, depois baseline do FSRS degenerada); fica como registro histórico de metodologia.

## Dataset

- `nbalepur/KARL` (Hugging Face), split único `train`, 123.143 linhas, baixado em `data/karl/train-00000-of-00001.parquet` (não versionado).
- **Licença: desconhecida.** Ausente da API do HF, do `README.md` do dataset (só front-matter YAML) e não há repositório associado (`github.com/nbalepur/KARL` retorna 404).
- `card_text` é só a pergunta/pista (estilo quiz bowl/Jeopardy!), nunca a resposta. `response` é booleano puro, sem nulos: `true`=acertou (71,8%), `false`=errou (28,2%).
- 543 usuários distintos, 60 decks distintos, 18.663 `card_id` distintos.

## Fonte de respostas — `facts.csv` (`Pinafore/fact-repetition`, MIT license para o código)

- Clonado via `git lfs pull -I facts.csv` de `github.com/Pinafore/fact-repetition`, copiado para `data/karl/facts.csv` (não versionado).
- **18.662 de 18.663 `card_id`s do KARL (99,995%) batem com `fact_id` de `facts.csv`**, com texto de pergunta idêntico caractere a caractere em todas as amostras verificadas. O único `card_id` sem match (`234825`) usa fallback de só-pergunta.
- Colunas relevantes de `facts.csv`: `fact_id`, `text` (pergunta, igual a `card_text`), `answer` (resposta correta).

## Decisão de protocolo (fixada antes de rodar)

**O vocabulário usa pergunta + resposta** (`front = card_text + " " + answer` quando há match por `card_id`; só `card_text` no único card sem match). Motivo: respostas estão disponíveis e batem quase perfeitamente com os `card_id`s do KARL — descartar essa informação jogaria fora a maior parte do conteúdo semântico do cartão (a pergunta sozinha frequentemente não contém o termo-chave, só pistas sobre ele).

Nota de limpeza: `answer` às vezes tem anotações de julgamento entre colchetes (ex. `"Simon Bolivar [or Simón José Antonio de la Santísima Trinidad Bolívar y Palacios; prompt on El Libertador until read]"`). O `ingest/karl.ts` deve remover o conteúdo entre colchetes antes de compor o `front`, para não poluir o vocabulário com instruções de julgamento de quiz bowl.

## Mapeamento de rating

- `response = true` → Good (FSRS rating 3)
- `response = false` → Again (FSRS rating 1)

## Filtro de usuários

Só usuários com **≥200 revisões avaliáveis** e **≥20 falhas no split de teste**. Reportar quantos usuários passam.

### Emenda registrada antes de rodar qualquer variante: definição de "avaliável"

A definição herdada do pipeline do `.apkg` (`elapsedDays >= 1` desde a revisão anterior do mesmo cartão) **não se aplica ao KARL**: repetições do mesmo `card_id` no KARL tipicamente acontecem no mesmo dia (prática tipo Leitner/quiz bowl com requeue rápido), não em intervalos de dias como no Anki. Com essa definição, **0 de 543 usuários** atingem 200 revisões avaliáveis (o usuário com mais revisões no dataset inteiro, 16.265 linhas, só tem 72). Verificado antes de qualquer variante ser rodada, não depois de ver resultados.

**Definição corrigida, fixada agora:** avaliável = qualquer revisão após a 1ª exposição ao cartão (`predictedR !== null`; só a toda-primeira exposição a cada fato fica de fora, por não ter estado prévio para prever). Com essa definição, **78 de 543 usuários** passam no filtro (≥200 avaliáveis e ≥20 falhas no split de teste).

Consequências fixadas junto com a emenda:
- O baseline FSRS usa `enableShortTerm: true` na otimização (já era o padrão em `optimizeParameters`, sem mudança de código) para tratar corretamente revisões no mesmo dia.
- Todo resultado é reportado em **dois recortes adicionais**, calculados sobre o conjunto de revisões avaliáveis: **mesmo dia** (`elapsedDays === 0`) e **intervalo ≥1 dia** (`elapsedDays >= 1`). O **critério de sucesso continua definido sobre o total** (avaliáveis, sem separar por recorte); os dois recortes entram no relatório como informação suplementar, não como critério adicional de vitória.

## Variantes e controles (fixados, mesma ordem de report)

1. **Variante principal**: vocabulário sem palavras funcionais (`extractVocabularyConcepts(front, { excludeFunctionWords: true })`), `front` = pergunta+resposta conforme decisão acima.
2. **Comparação**: vizinhos por embedding local (similaridade), como no paper do KARL.
3. **Controle**: nó por deck (`deck_id`/`deck_name`, sem alterar/agrupar decks).
4. **Controle**: nó global único.
5. **Controle**: permutação (1000x), refazendo a busca em grade de hiperparâmetros a cada permutação (não reaproveita os hiperparâmetros do modelo real).

## Definição de "vencer"

Diferença de log-loss vs. a variante base, com IC95% do bootstrap **agregado por usuário**, inteiramente do lado favorável à variante testada (IC não cruza zero, na direção correta).

## Critério de sucesso do teste KARL

A variante principal (vocabulário sem funcionais) precisa vencer **as três**: (a) FSRS puro/otimizado, (b) o controle por deck, e (c) a variante de similaridade por embedding. Vencer só uma ou duas não conta como sucesso.

## Emenda registrada antes de rodar a análise completa: baseline do FSRS degenerada em revisões no mesmo dia

Verificado antes de rodar em escala: `forgetting_curve(0, S) = 1` exatamente, para qualquer estabilidade — logo, com o tempo decorrido arredondado para dias inteiros (como no replay do `.apkg`), **toda revisão no mesmo dia recebe `predictedR=1`**, não importa o resultado real. Confirmado em dados reais: usuário 46, 2.159 revisões no mesmo dia, `predictedR` = 1,0 em 100% delas, mas 703 dessas revisões (32,6%) foram erradas. Como ~91% das revisões avaliáveis do KARL são no mesmo dia, isso torna o FSRS uma baseline sem poder de discriminação (AUC≈0,50) para a maior parte dos dados — não um bug de implementação, mas uma consequência de arredondar o tempo para dias inteiros quando a maioria das repetições do KARL acontece dentro do mesmo dia.

**Correção fixada:** `replayCardFractional`/`replayAllFractional` (`src/fsrs/replay.ts`) alimentam `next_state`/`forgetting_curve` com o tempo decorrido **fracionário** (`elapsedMs / MS_PER_DAY`, sem arredondar), em vez do valor arredondado usado por `replayCard`. A classificação em recortes (mesmo dia / ≥1 dia) continua usando o valor arredondado (`elapsedDays`) — só o `t` alimentado ao FSRS muda. Os parâmetros do FSRS continuam otimizados com `buildTrainingItems`/`optimizeParameters` inalterados (dias inteiros): mudar o formato de entrada do otimizador nativo (`fsrs-rs`) arriscaria um panic não capturável, o mesmo risco já documentado para itens com `delta_t=0`. A correção se aplica a todos os modelos igualmente (FSRS e todas as variantes/controles), pois todos consomem o mesmo `predictedR` gerado pelo replay fracionário.

## Emenda: recorte principal passa a ser "intervalo ≥1 dia", com filtro de usuário próprio

Registrado antes de rodar a análise completa, substituindo a definição de "recorte principal" (mas não a definição de "avaliável" em si, nem o filtro original de 78 usuários usado para relatar a proporção mesmo-dia/≥1-dia no dataset):

- **Análise principal:** revisões com intervalo **≥1 dia** desde a revisão anterior do mesmo cartão, juntando todos os usuários com **≥20 revisões desse tipo** (novo filtro, mais permissivo que o anterior — o filtro de ≥200 avaliáveis/≥20 falhas no teste tornava a análise principal inviável, já que a maioria das revisões do KARL é no mesmo dia; ver contagem exata reportada antes de rodar). Bootstrap agregado por usuário.
- **Análise secundária:** revisões no mesmo dia, com a ressalva explícita de que o FSRS (mesmo com a correção fracionária) não foi desenhado para esse regime de repetição — reportada para contexto, não para decidir a hipótese.
- **O critério de sucesso (variante principal vence FSRS, controle por deck e variante de embedding) aplica-se só à análise principal (recorte ≥1 dia).**

## Grades de hiperparâmetros (fixadas antes de rodar, busca em grade só no treino de cada usuário)

- Variantes de conceito (principal, controle por deck, controle global): `priorVariance ∈ {0.25, 1}`, `driftPerDay ∈ {0.001, 0.01}`, `lambda ∈ {0, 0.25, 0.5, 1, 2}` — mesma grade do ablation do English.apkg, para comparabilidade direta. Sem self-link (cartão só se conecta ao(s) nó(s) de conceito).
- Variante de comparação (vizinhos por embedding): mesma grade de `priorVariance`/`driftPerDay`, mais `tau ∈ {0.5, 0.7, 0.85, 0.95}` e `lambda ∈ {0, 0.25, 0.5, 1, 2}` (`rescaleSimilarity`), `k=5` vizinhos (mesmo default de `computeNeighborSets`). Self-link fixo em peso 1 (cartão sempre ligado a si mesmo), por convenção já testada em `bayesian.test.ts` — então mesmo com `lambda=0` este modelo não é um pass-through puro do FSRS (é recalibração por cartão sem transferência de vizinhos), diferente das variantes de conceito.

## Escopo da permutação (1000x)

A permutação testa se a atribuição cartão→rótulo carrega sinal genuíno, embaralhando essa atribuição **dentro de cada usuário** (nunca entre usuários) e refazendo a busca em grade por usuário a cada uma das 1000 permutações. Roda para a **variante principal** (vocabulário sem funcionais) e o **controle por deck** — ambos têm uma atribuição cartão→rótulo discreta que faz sentido embaralhar, como nos controles do English.apkg. Não roda para: o controle de nó global único (embaralhar uma atribuição uniforme não muda nada — mesmo motivo do English.apkg) nem para a variante de vizinhos por embedding (não é uma atribuição cartão→rótulo discreta; é uma estrutura de grafo k-NN sobre embeddings, sem um análogo direto de "embaralhar" no mesmo sentido). A variante de embedding entra na comparação só via IC95% do bootstrap, conforme o critério de sucesso já define.

## Restrição

Nenhuma chamada a API de modelo (Anthropic, Google etc.) nesta fase. Embeddings locais (`@huggingface/transformers`, já usado no projeto) são permitidos por não serem uma API externa.
