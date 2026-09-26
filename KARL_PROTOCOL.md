# Protocolo pré-registrado — teste no dataset KARL

Registrado **antes** de rodar qualquer variante ou controle, conforme instrução explícita do usuário. Nada aqui deve mudar depois de ver resultados.

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

## Restrição

Nenhuma chamada a API de modelo (Anthropic, Google etc.) nesta fase. Embeddings locais (`@huggingface/transformers`, já usado no projeto) são permitidos por não serem uma API externa.
