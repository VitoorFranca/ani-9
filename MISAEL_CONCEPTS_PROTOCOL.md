# Protocolo pré-registrado — lista fixa de conceitos por LLM nos baralhos do Misael

Registrado **antes** de rodar qualquer geração de lista, classificação ou avaliação. Nada aqui deve mudar depois de ver resultados (exceto emendas explicitamente marcadas como tal, como no `MISAEL_PROTOCOL.md`).

## Contexto

Mesma pergunta do teste de vocabulário (`MISAEL_PROTOCOL.md`), mas com conceitos gerados por LLM (Gemini 3.1 Flash-Lite) em vez de palavras de vocabulário por regra — reaproveitando exatamente a infraestrutura já construída e testada para o English.apkg (`src/concepts/fixed-list.ts`, `src/concepts/classify.ts`, `src/concepts/gemini-client.ts`), sem mudanças de código nelas.

## Dados

Mesmos 3 baralhos combinados de `data/misael/`, mesma ingestão/pooling já verificado (sem colisão de `cardId`) em `MISAEL_PROTOCOL.md`. 1.571 cartões elegíveis (com conteúdo e ≥1 revisão), divididos: Língua Portuguesa=270, Direito Administrativo=982, Administração Pública=319.

## Geração da lista (uma por baralho)

- Amostra de **100 cartões** por baralho, via `selectFixedListSample(cards, 100, seed=42)` (já existente — prioriza cartões de frase sobre palavra única, para maximizar variedade de padrões na amostra).
- Gerada por `generateFixedList` (`src/concepts/fixed-list.ts`, prompt já existente, sem alterações), modelo `gemini-3.1-flash-lite`, `thinkingLevel: MINIMAL`.
- Regras já embutidas no prompt (confirmadas contra o pedido): dois conceitos são diferentes se alguém pode saber um sem o outro; cada conceito deve aparecer em ≥3 cartões da amostra; cita os IDs de 2 cartões de exemplo por conceito; conceitos atômicos (uma ideia por conceito); vocabulário de palavra única é excluído (coberto por regra separada, não por LLM); entre 30 e 80 conceitos por lista.
- **As 3 listas geradas são mostradas ao usuário, que revisa antes de qualquer classificação prosseguir.**

## Classificação

- Cada cartão elegível do baralho recebe, da lista fixa **daquele baralho** (não misturando listas entre baralhos), os conceitos que exige — pode ser nenhum. Via `classifyCards` (`src/concepts/classify.ts`, sem alterações), `batchSize=30` (padrão).
- **20 cartões aleatórios (seed fixa) são mostrados com seus conceitos atribuídos, para auditoria pelo usuário**, antes da avaliação prosseguir.

## Avaliação (mesmo protocolo do teste de vocabulário)

- **Base**: FSRS + nó por baralho (reaproveitando exatamente `deckTest`/`deckGrid` já calculados em `analyze-misael.mts`, sem recomputar).
- **Variante**: base + conceitos da lista fixa, no mesmo cartão, com **λ separados** (`lambdaDeck`, `lambdaConcept`) — mesma correção já aplicada e testada no teste de vocabulário (evita o bug de diluição de peso do deck e o bug do fallback de cartão sem baralho atribuído). Grade: `priorVariance ∈ {0.25, 1}`, `driftPerDay ∈ {0.001, 0.01}`, `lambdaDeck ∈ {0, 0.25, 0.5, 1, 2}`, `lambdaConcept ∈ {0, 0.25, 0.5, 1, 2}` (4D, 100 combinações) — mesma grade do teste de vocabulário.
- **Verificação de equivalência** (obrigatória antes de aceitar qualquer resultado, mesmo procedimento que pegou o bug real no teste de vocabulário): com `lambdaConcept=0` e os mesmos `priorVariance`/`driftPerDay`/`lambdaDeck` do controle "deck sozinho", a variante precisa reproduzir exatamente (diferença ponto-a-ponto < 1e-12) o controle "deck sozinho" no teste.
- **Bootstrap por cartão, 3.000 iterações**, variante vs base. **Se o IC95% não estiver inteiramente a favor da variante, o teste para aqui — não roda permutação, resultado registrado como final** (mesma regra de decisão do teste de vocabulário).
- **Se o IC estiver a favor**: permutação de 1.000x, embaralhando **só a atribuição de conceitos da lista** (rótulo de deck permanece fixo em cada permutação), refazendo a grade 4D a cada permutação — critério de sucesso final exige IC a favor **e** p<0,05.

## Custo e aprovação

**Nenhuma chamada ao Gemini é feita sem aprovação explícita prévia**, para geração de lista OU classificação. Estimativa abaixo, calculada a partir de contagens reais de cartões e tamanho médio de texto (não um chute):

- Geração de lista: 3 chamadas (uma por baralho), ~9.000 tokens de entrada e ~1.850 de saída cada (amostra de 100 cartões, ~85 tokens/cartão + lista de 30-80 conceitos gerada) → **≈ US$0,015** no total.
- Classificação: lotes de 30 cartões/chamada → 9 + 33 + 11 = **53 chamadas**, ~3.675 tokens de entrada e ~700 de saída cada → **≈ US$0,104** no total.
- **Total estimado: ≈ US$0,12** (com margem, algo entre US$0,10 e US$0,15), preço `gemini-3.1-flash-lite`: US$0,25/1M tokens de entrada, US$1,50/1M de saída (mesmo preço já verificado e usado no English.apkg).

## Restrição

Nenhuma outra chamada de API além do Gemini para geração de lista e classificação, ambas explicitamente aprovadas por etapa.
