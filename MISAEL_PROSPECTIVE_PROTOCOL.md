# Protocolo prospectivo, congelado — nó de tópico de curto prazo

Registrado e **congelado em 2026-09-26**. Nada aqui — modelo, hiperparâmetros, definições — é reajustado depois desta data, nem mesmo ao avaliar. Este é o teste de confirmação fora da amostra para o resultado exploratório de `MISAEL_CONCEPTS_PROTOCOL.md` ("nó de tópico de curto prazo": Δ=0,0432, IC95=[-0,0045, 0,0944] sobre os dados históricos até aqui — não passou no critério estrito, mas foi o mais próximo de toda a investigação).

## Modelo exato, congelado

- **FSRS**: os mesmos parâmetros já otimizados em todo este projeto (`optimizeParameters(train)`, split cronológico 70/30 sobre os dados históricos até 2026-09-26). **Não reotimizado** ao avaliar no futuro — o replay continua com o `FSRSAlgorithm` já fixado.
- **Base**: FSRS + nó por baralho (persistente, entre sessões), hiperparâmetros congelados: `priorVariance=0.25, driftPerDay=0.01, lambda=2` (o `deckGrid.best` já registrado em `MISAEL_CONCEPTS_PROTOCOL.md`).
- **Variante**: base + nó de tópico de curto prazo — identificador do nó = `${sessionId}::${tópico}` (a mesma definição de sessão de `MISAEL_SESSION_PROTOCOL.md`: revisões consecutivas com gap <30min, fluxo pooled de todas as revisões; a mesma definição de tópico de `MISAEL_CONCEPTS_PROTOCOL.md`: subbaralho, com fallback para o rótulo de baralho). O nó reinicia (theta=0, variância=priorVariance) a cada nova sessão — não há alteração em `GraphBayesianModel`, só no identificador do nó.
- **Hiperparâmetros da variante, congelados** (escolhidos pela busca em grade em `analyze-misael-concepts-shortterm-topic.mts`, não re-otimizados): `priorVariance=1, driftPerDay=0.01, lambdaDeck=0, lambdaExtra=2`.

## Avaliação

- **Só revisões espaçadas** (`includedInEval`, gap ≥1 dia desde a revisão anterior do mesmo cartão) **feitas estritamente após 2026-09-26** — corte em `2026-09-27T00:00:00Z` (dia-calendário UTC, mesma convenção já usada no resto do projeto). Revisões até 2026-09-26 (inclusive) são histórico, nunca entram nesta avaliação.
- **Δ log-loss** = logLoss(base) − logLoss(variante), sobre essas revisões novas.
- **Critério de sucesso**: IC95% do bootstrap por sessão (`bootstrapLogLossDeltaByGroup`, agrupado por sessão, mesma convenção de `MISAEL_CONCEPTS_PROTOCOL.md`) **inteiramente a favor da variante** (não cruza zero).

## Requisito mínimo antes de avaliar

**≥150 falhas** (revisões espaçadas novas com resultado errado) acumuladas desde 2026-09-27. Antes de atingir esse mínimo, **não se calcula Δ nem IC** — só se reporta quantas faltam. Avaliar antes disso, mesmo informalmente, invalidaria o caráter prospectivo do teste.

## Restrição

Sem API. Sem reajuste de hiperparâmetros, modelo ou definição de qualquer tipo após 2026-09-26 — qualquer mudança necessária vira um novo teste, não uma correção deste.
