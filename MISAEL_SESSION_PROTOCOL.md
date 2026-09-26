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

## Execução desta rodada

**Só contagens** — sessões detectadas e pares por grupo (relacionados × A-certo, relacionados × A-errado, não relacionados × A-certo, não relacionados × A-errado). Nenhum resíduo, efeito ou bootstrap é calculado nesta etapa. Resultado reportado, depois **para** para revisão antes de prosseguir para a medida e o critério de sucesso acima.

## Restrição

Sem API nesta etapa (usa a classificação e os tópicos já em cache).
