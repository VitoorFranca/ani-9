# Protocolo pré-registrado — efeito de sessão (contágio entre cartões relacionados)

Registrado **antes** de rodar qualquer contagem, resíduo ou teste. Nada aqui deve mudar depois de ver resultados.

## Pergunta

Errar um cartão A pouco antes de revisar um cartão B **relacionado** (mesmo tópico ou conceito da lista fixa) prejudica B mais do que errar um cartão A **não relacionado**? Se sim, isso é evidência indireta de estrutura de conceito real (contágio de erro entre cartões relacionados), sem exigir que a camada de conceito bata o FSRS+baralho em log-loss agregado — um efeito local, não um modelo melhor.

## Dados e definições

- Mesmos 3 baralhos combinados de `data/misael/`, mesmo pooling já usado em `MISAEL_PROTOCOL.md`/`MISAEL_CONCEPTS_PROTOCOL.md`.
- **Sessão**: revisões consecutivas com **menos de 30 min** entre uma e outra, no fluxo cronológico **de todas as revisões, de todos os cartões** (revlog bruto após filtro, `allReviews` — inclui cartões sem conteúdo, para não quebrar artificialmente uma sessão real; pares só se formam entre revisões elegíveis, ver abaixo). Um gap ≥30 min inicia uma nova sessão.
- **Par**: cartão A revisado antes de cartão B, **na mesma sessão**, com **B até 2h depois de A** (`timestamp(B) - timestamp(A) <= 2h`). **A e B precisam ser cartões diferentes** (`A.cardId != B.cardId`) — o efeito medido é contágio entre cartões, não repetição do mesmo cartão. Só entram no par cartões **elegíveis** (com conteúdo e usados no pooling — os mesmos de `allCards` em `analyze-misael*.mts`).
- **Relacionados**: `topicByCard.get(A) === topicByCard.get(B)` (mesmo tópico, com o mesmo fallback deck-label de `MISAEL_CONCEPTS_PROTOCOL.md` quando não há subbaralho real) **OU** interseção não vazia entre `listConceptsByCard.get(A)` e `listConceptsByCard.get(B)` (algum conceito da lista fixa em comum). **Não relacionados**: nenhuma das duas condições.
- **Para cada B**, entre todos os A candidatos (mesma sessão, ≤2h antes, cartão diferente), agrupa-se em "relacionados" e "não relacionados" e usa-se **só o A mais recente de cada grupo** (o de maior timestamp ainda ≤2h antes de B) — no máximo 2 pares por B (um relacionado, um não relacionado), zero se não houver candidato num grupo.
- **Só entram pares em que B é uma revisão espaçada** (`includedInEval` do replay padrão — gap ≥1 dia desde a revisão anterior do mesmo cartão B). A condição é sobre B; A não precisa ser espaçada.

## Medida (a ser calculada em etapa posterior, não nesta rodada)

- **Resíduo de B** = resultado real de B (1 acerto, 0 erro) − previsão da base (FSRS + nó por baralho, `deckGrid.best` já registrado em `MISAEL_CONCEPTS_PROTOCOL.md`, replay contínuo por todo o histórico, previsão sempre calculada só com o histórico anterior a B — a mesma convenção online já usada em todo o pipeline).
- **Efeito(grupo)** = resíduo médio de B após A errado − resíduo médio de B após A certo, dentro do grupo (relacionados ou não relacionados).
- **Efeito de conceito** = Efeito(relacionados) − Efeito(não relacionados).

## Critério de sucesso (a ser avaliado em etapa posterior)

Efeito de conceito **negativo**, com **IC95% do bootstrap por sessão** (resample de sessões inteiras, não de pares nem de cartões) **inteiramente abaixo de zero**.

## Emenda registrada ANTES de calcular resíduos/efeitos: recorte suplementar "mesmo baralho"

Motivação: no recorte principal, "não relacionados" pode incluir pares de baralhos diferentes (ex. um cartão de Língua Portuguesa como A "não relacionado" de um B de Direito Administrativo) — um efeito encontrado aí poderia ser só heterogeneidade entre baralhos (já sabida ser forte, ver `MISAEL_PROTOCOL.md`), não estrutura de conceito.

- **Relacionados**: definição idêntica ao recorte principal (mesmo tópico OU conceito da lista em comum) — não muda.
- **Não relacionados (recorte suplementar)**: **mesmo baralho** que B, subbaralho diferente, e nenhum conceito em comum — restringe o grupo de controle a pares dentro do mesmo assunto amplo.
- Para cada B, o A mais recente de cada grupo é escolhido independentemente para os dois recortes (o "relacionado" pode ser o mesmo A nos dois recortes; o "não relacionado" pode diferir, já que o pool candidato do suplementar é um subconjunto do principal).
- **Contagens do recorte suplementar reportadas antes de calcular qualquer resíduo/efeito** (mesma prática do recorte principal).
- **Interpretação registrada antes de ver resultados**: o critério de sucesso principal não muda. Mas se o recorte principal passar (efeito de conceito negativo, IC abaixo de zero) e o suplementar **não** passar, o resultado é interpretado como **efeito de baralho**, não efeito de conceito genuíno — não conta como confirmação da hipótese de conceito.

## Execução desta rodada

Contagens dos dois recortes (principal e suplementar) reportadas primeiro. Depois, resíduos, efeitos e bootstrap por sessão (3.000 iterações, seed 42 — mesma convenção do resto do projeto) calculados e reportados para os dois recortes.

## Restrição

Sem API (usa a classificação e os tópicos já em cache).
