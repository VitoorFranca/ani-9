# Teste no dataset KARL — relatório final

**Veredito: teste encerrado por falta de poder estatístico, sem rodar a análise principal.** Não é um resultado positivo nem negativo sobre a hipótese da Fase 1 — é uma constatação de inviabilidade deste dataset, com este filtro, para testar o regime de revisão espaçada (o caso de uso real do projeto). Nenhuma variante, controle ou permutação chegou a ser rodada com o pipeline final; a decisão de encerrar foi tomada só a partir de contagens de tamanho de amostra, antes de qualquer resultado sobre a hipótese em si.

## Objetivo

Reproduzir, num dataset real independente e maior, o teste já feito no `English.apkg` (Fase 1, ver [`report.md`](./report.md)) — cujo veredito já era cético (nenhuma evidência de transferência por conteúdo; o único efeito significativo era explicado por notetype, não por vocabulário). O KARL (`nbalepur/KARL`, Hugging Face) foi escolhido por ser público, grande (123.143 linhas, 543 usuários) e ter estrutura de "cartão" e resultado (`response`) claros.

## O que foi feito

1. **Dataset baixado e inspecionado** (ver [`KARL_PROTOCOL.md`](./KARL_PROTOCOL.md)): licença ausente (não encontrada na API do HF, no README do dataset, nem em repositório associado — sinalizado, não bloqueou o uso para teste interno). `card_text` é só a pergunta (estilo quiz bowl), nunca a resposta.
2. **Respostas recuperadas via fonte externa**: `facts.csv` (`Pinafore/fact-repetition`, MIT license), casando 18.662/18.663 `card_id`s do KARL por texto idêntico. Decisão pré-registrada: vocabulário usa pergunta+resposta.
3. **Adaptador de ingestão** (`src/ingest/karl.ts`, testado): mapeia registros do KARL para os tipos de domínio (`Review`, `NormalizedCard`) já usados pelo resto do pipeline, com `correto→Good`/`incorreto→Again`.
4. **Duas falhas de protocolo descobertas e corrigidas ANTES de rodar qualquer variante** (ambas documentadas em detalhe no `KARL_PROTOCOL.md`, com a numeração exata de usuários/revisões em cada etapa):
   - A definição de "revisão avaliável" herdada do pipeline do `.apkg` (gap ≥1 dia) dava **0 de 543 usuários** qualificados — corrigida para "qualquer revisão após a 1ª exposição ao cartão", dando 78/543.
   - O FSRS, com o tempo decorrido arredondado para dias inteiros, prevê **R=1,0 exatamente** para toda revisão no mesmo dia (`forgetting_curve(0, S) = 1`, sempre) — verificado em dados reais (2.159 revisões no mesmo dia de um usuário, `predictedR`=1,0 em 100% delas, mas 703 erradas). Corrigido com `replayCardFractional`/`replayAllFractional` (`src/fsrs/replay.ts`, testado), que alimenta o FSRS com tempo decorrido fracionário em vez de arredondado.
5. **Análise principal redefinida** para o recorte de revisões com intervalo **≥1 dia** (o único regime que representa revisão espaçada de fato — o caso de uso deste projeto), com filtro próprio de **≥20 revisões desse tipo por usuário**.

## Por que o teste foi encerrado

Contando as revisões de intervalo ≥1 dia sob a definição corrigida:

| user | revisões ≥1 dia | falhas |
|---|---|---|
| 38 | 72 | 9 |
| 496 | 40 | 8 |
| 123 | 38 | 2 |
| 463 | 31 | 11 |
| 521 | 22 | 16 |
| 413 | 20 | 8 |

**Só 6 de 543 usuários** têm ≥20 revisões de intervalo ≥1 dia. Somando os 6: **223 revisões, 54 falhas** — abaixo do mínimo de ~300 falhas necessário para dar poder estatístico a uma busca em grade por usuário (20-80 combinações de hiperparâmetros) seguida de bootstrap agregado por usuário e permutação de 1000x. Com 6 grupos, o bootstrap por usuário teria resolução muito grosseira, e a busca em grade por usuário tem risco real de sobreajuste em conjuntos de treino tão pequenos.

A análise do recorte "mesmo dia" (que tem volume grande — a maioria das revisões do KARL) **não foi rodada**: não representa o caso de uso deste projeto (revisão espaçada em dias, não repetição rápida no mesmo dia/sessão), então rodá-la não responderia a pergunta da Fase 1 mesmo com volume suficiente.

## O que isso significa (e o que não significa)

- **Não é evidência a favor nem contra a hipótese de transferência por conteúdo.** Nenhuma variante de vocabulário, controle por deck, controle global ou comparação por embedding chegou a ser avaliada com o pipeline corrigido — a decisão de parar foi tomada só a partir da contagem de usuários/revisões qualificados, antes de olhar qualquer log-loss ou AUC de variante.
- **O KARL não é o dataset certo para testar revisão espaçada.** É um dataset de prática de quiz bowl/trivia com repetição predominantemente no mesmo dia/sessão (Leitner-style requeue rápido), não um dataset de uso real de flashcards espaçados em dias como o Anki. A maioria dos usuários simplesmente não tem histórico suficiente de revisões com dias de intervalo.
- **A infraestrutura construída é reaproveitável.** `src/ingest/karl.ts`, `src/fsrs/replay.ts` (`replayCardFractional`/`replayAllFractional`), e o pipeline completo em `scripts/analyze-karl-concept-model.mts` (validado com um smoke test de 2 usuários, que foi o que revelou o bug do FSRS degenerado) ficam no repositório, testados, caso um dataset KARL-like maior ou filtrado de outra forma apareça no futuro.

## Estado da Fase 1 após os dois testes

- **English.apkg** (`report.md`): sem evidência de transferência por conteúdo; o único efeito significativo é explicado por notetype, não por vocabulário.
- **KARL**: teste inconclusivo por falta de poder estatístico no regime relevante (revisão espaçada) — não chegou a testar a hipótese.

Nenhum dos dois testes até agora produziu evidência a favor da camada de conceitos.
